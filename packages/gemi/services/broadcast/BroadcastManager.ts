import type { Application } from "../../foundation/Application";
import type { ChannelRouter, ChannelRouterClass } from "../../http/ChannelRouter";
import { afterCommit } from "../../orm/context";
import { withDefaults } from "../../support/withDefaults";
import type { BroadcastDeliver, BroadcastDriver, BroadcastDriverHooks } from "./BroadcastDriver";
import type { BroadcastableEvent } from "./brand";
import {
  assertEventName,
  assertTopic,
  buildTopic,
  isChannelTarget,
  USER_CHANNEL,
  userTopic,
  type ChannelParamsArgs,
  type ChannelTarget,
} from "./channels";
import { broadcastConfigDefaults, type BroadcastConfig } from "./config";
import { MemoryBroadcastDriver } from "./MemoryBroadcastDriver";
import type { BroadcastDataArgs, BroadcastEventsFor, SentBroadcast } from "./types";
import { encodeEventFrame, isSocketId, SOCKET_ID_HEADER } from "./wire";

/** An emit whose frame is bigger than `maxEventBytes`. Nothing was sent. */
export class BroadcastPayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
    event: string,
  ) {
    super(
      `The broadcast "${event}" is ${bytes} bytes, over the limit of ${limit}. ` +
        `Send ids and a change hint, and let the client fetch the data over ` +
        `HTTP; or raise maxEventBytes in app/config/broadcast.ts.`,
    );
    this.name = "BroadcastPayloadTooLargeError";
  }
}

/** Something that carries the sender's socket id: a request, or the id. */
export type SocketSource =
  | string
  | null
  | undefined
  | Request
  | { rawRequest: Request }
  | { headers: Headers };

/**
 * Real-time, volatile fan-out to the WebSocket clients subscribed to a
 * channel. Events are hints that something changed, not data: delivery is at
 * most once, nothing is stored or replayed, and a client that may have missed
 * something refetches over HTTP.
 *
 * ```ts
 * Broadcast.to("site.:siteId", { siteId: site.publicId }).emit("changed", { pages: ["/about"] });
 * ```
 *
 * The manager builds and checks the frame at the call site, so a bad channel
 * or a payload over the limit throws there, and then hands it to the driver,
 * which decides which processes see it. Inside an ORM transaction the
 * hand-off waits for the commit and is dropped on rollback.
 *
 * Delivery to sockets belongs to the transport, which calls `start` with the
 * function that reaches this process's sockets. Until it does, an emit
 * reaches no socket in this process.
 */
export class BroadcastManager {
  static token = "broadcast";

  readonly config: Required<BroadcastConfig>;
  readonly driver: BroadcastDriver;
  private readonly warnedAboutSize = new Set<string>();
  private started = false;
  private channelRouter: ChannelRouter | null | undefined;

  constructor(
    config: BroadcastConfig = {},
    private readonly options: {
      application?: Application;
      /** The app's `ChannelRouter` (`route.channels`). */
      channels?: ChannelRouterClass;
    } = {},
  ) {
    this.config = withDefaults(broadcastConfigDefaults(), config);
    this.driver = resolveDriver(this.config.driver, options.application);
  }

  /**
   * The app's `ChannelRouter`, built once, or `null` when `route.channels` is
   * not set (and every subscription is refused). The transport authorizes
   * each `sub` with its `authorize`.
   */
  get channels(): ChannelRouter | null {
    if (this.channelRouter === undefined) {
      this.channelRouter = this.options.channels ? new this.options.channels() : null;
    }
    return this.channelRouter;
  }

  /**
   * The channel `pattern` names with `params`, or a concrete topic, or a
   * `ChannelTarget` (what `BroadcastEvent.channel()` returns).
   */
  to<P extends string>(
    pattern: P | ChannelTarget,
    ...params: ChannelParamsArgs<P>
  ): PendingBroadcast<BroadcastEventsFor<P>> {
    return new PendingBroadcast(this, resolveTarget(pattern, params[0]), null);
  }

  /** A user's own channel, `user.<id>`: the one the router's `"user"` channel joins. */
  toUser(user: { id: unknown } | string | number): PendingBroadcast<BroadcastEventsFor<"user">> {
    return new PendingBroadcast(this, { topic: userTopic(user), pattern: USER_CHANNEL }, null);
  }

  /**
   * Skips the socket that made `source`, a request carrying the
   * `X-Gemi-Socket` header (or the id itself), so the client that saved
   * something does not refetch what it already has. Without a valid socket id
   * nobody is skipped.
   */
  toOthers(source: SocketSource): BroadcastScope {
    return new BroadcastScope(this, socketIdOf(source));
  }

  /** Sends a `BroadcastEvent` to the channels its `broadcastOn` names. */
  broadcastEvent(event: BroadcastableEvent): void {
    const on = event.broadcastOn();
    const targets = Array.isArray(on) ? on : [on as ChannelTarget | string];
    const name = event.broadcastAs();
    const data = event.broadcastWith();
    for (const target of targets) {
      this.send(resolveTarget(target, undefined), name, data, null);
    }
  }

  /**
   * Checks and encodes an emit, then hands it to the driver: now, or after
   * the open transaction commits. Throws at the call site for a bad event
   * name, a payload that is not JSON, or one over `maxEventBytes`.
   */
  send(target: ChannelTarget, event: string, data: unknown, except: string | null): void {
    assertEventName(event);
    let frame: string;
    try {
      frame = encodeEventFrame(target.topic, event, data, except);
    } catch (cause) {
      throw new TypeError(`The broadcast "${event}" could not be encoded. Payloads must be JSON.`, {
        cause,
      });
    }
    this.checkSize(event, frame);

    const sent: SentBroadcast = {
      topic: target.topic,
      ...(target.pattern ? { pattern: target.pattern } : {}),
      event,
      data,
      ...(except ? { except } : {}),
    };
    void afterCommit(() => this.publish(sent, frame));
  }

  /**
   * The hand-off to the driver, after the commit. Never throws: an emit is
   * fire-and-forget, and a driver failure is logged with the topic and event,
   * never the payload.
   */
  protected publish(sent: SentBroadcast, frame: string): void {
    const failed = (error: unknown) =>
      console.error(
        `[gemi] The broadcast "${sent.event}" on "${sent.topic}" could not be published.`,
        error,
      );
    try {
      const result = this.driver.publish(sent.topic, frame);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(failed);
      }
    } catch (error) {
      failed(error);
    }
  }

  /** Whether the transport has started delivering to this process's sockets. */
  get isStarted(): boolean {
    return this.started;
  }

  /**
   * For the transport: this process starts receiving, and every frame for a
   * topic it has sockets on reaches `deliver` (`server.publish`).
   */
  async start(deliver: BroadcastDeliver, hooks?: BroadcastDriverHooks): Promise<void> {
    if (this.started) {
      throw new Error("The broadcast driver was already started in this process.");
    }
    this.started = true;
    await this.driver.start(deliver, hooks);
  }

  /** For the transport: the first local socket joined `topic`. */
  topicAdded(topic: string): void | Promise<void> {
    return this.driver.topicAdded?.(topic);
  }

  /** For the transport: the last local socket left `topic`. */
  topicRemoved(topic: string): void | Promise<void> {
    return this.driver.topicRemoved?.(topic);
  }

  async close(): Promise<void> {
    this.started = false;
    await this.driver.close();
  }

  private checkSize(event: string, frame: string) {
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > this.config.maxEventBytes) {
      throw new BroadcastPayloadTooLargeError(bytes, this.config.maxEventBytes, event);
    }
    const warnAt = this.config.warnEventBytes;
    if (warnAt !== false && bytes > warnAt && !this.warnedAboutSize.has(event)) {
      this.warnedAboutSize.add(event);
      console.warn(
        `[gemi] The broadcast "${event}" is ${bytes} bytes, over ${warnAt}. ` +
          `Broadcasts are change hints: send ids and let the client fetch the ` +
          `data over HTTP. Warned once per event name.`,
      );
    }
  }
}

/** An emit with its channel chosen: `.emit(event, data)` sends it. */
export class PendingBroadcast<Events extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly manager: BroadcastManager,
    readonly target: ChannelTarget,
    private readonly except: string | null,
  ) {}

  /**
   * Sends `event` with `data` (JSON) to every socket on the channel. Returns
   * nothing: delivery is at most once and never acknowledged.
   */
  emit<E extends keyof Events & string>(event: E, ...data: BroadcastDataArgs<Events[E]>): void {
    this.manager.send(this.target, event, data[0], this.except);
  }
}

/** `Broadcast.toOthers(...)`: the same `to`, with the sender's socket skipped. */
export class BroadcastScope {
  constructor(
    private readonly manager: BroadcastManager,
    readonly except: string | null,
  ) {}

  to<P extends string>(
    pattern: P | ChannelTarget,
    ...params: ChannelParamsArgs<P>
  ): PendingBroadcast<BroadcastEventsFor<P>> {
    return new PendingBroadcast(this.manager, resolveTarget(pattern, params[0]), this.except);
  }

  toUser(user: { id: unknown } | string | number): PendingBroadcast<BroadcastEventsFor<"user">> {
    return new PendingBroadcast(
      this.manager,
      { topic: userTopic(user), pattern: USER_CHANNEL },
      this.except,
    );
  }
}

function resolveTarget(
  pattern: string | ChannelTarget,
  params: Record<string, unknown> | undefined,
): ChannelTarget {
  if (isChannelTarget(pattern)) {
    return {
      topic: assertTopic(pattern.topic),
      ...(pattern.pattern ? { pattern: pattern.pattern } : {}),
    };
  }
  if (params !== undefined || pattern.includes(":")) {
    return { topic: buildTopic(pattern, params ?? {}), pattern };
  }
  return { topic: assertTopic(pattern) };
}

function socketIdOf(source: SocketSource): string | null {
  if (source === null || source === undefined) return null;
  if (typeof source === "string") return isSocketId(source) ? source : null;
  const headers =
    source instanceof Request
      ? source.headers
      : "rawRequest" in source
        ? source.rawRequest.headers
        : source.headers;
  const id = headers?.get(SOCKET_ID_HEADER);
  return isSocketId(id) ? id : null;
}

function resolveDriver(
  driver: BroadcastConfig["driver"],
  application: Application | undefined,
): BroadcastDriver {
  if (driver === undefined || driver === "memory") return new MemoryBroadcastDriver();
  if (typeof driver === "function") {
    if (!application) {
      throw new Error("A broadcast driver factory needs the application to be called with.");
    }
    return driver(application);
  }
  if (typeof driver === "object" && driver !== null && typeof driver.publish === "function") {
    return driver;
  }
  throw new Error(
    `Unknown broadcast driver "${String(driver)}" in app/config/broadcast.ts. ` +
      `Use "memory", or pass a BroadcastDriver.`,
  );
}
