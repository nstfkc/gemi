import { DatabaseManager } from "../../database/DatabaseManager";
import type { Application } from "../../foundation/Application";
import { afterCommit, currentTransaction } from "../../orm/context";
import { withDefaults } from "../../support/withDefaults";
import type { ChangeFeedDriver, ChangeFeedEvent } from "./ChangeFeedDriver";
import { changeFeedConfigDefaults, type ChangeFeedConfig } from "./config";
import { decodeCursor, encodeCursor } from "./cursor";
import { DatabaseChangeFeedDriver } from "./DatabaseChangeFeedDriver";
import { MemoryChangeFeedDriver } from "./MemoryChangeFeedDriver";
import { changeFeedStream, type ChangeFeedResponse, type StreamOptions } from "./stream";

/** The longest channel name, in characters. */
export const MAX_CHANNEL_LENGTH = 255;

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** This process already holds `maxSubscriptions` subscriptions. */
export class ChangeFeedFullError extends Error {
  constructor(readonly limit: number) {
    super(`The change feed holds its limit of ${limit} subscriptions.`);
    this.name = "ChangeFeedFullError";
  }
}

export type SubscribeOptions = {
  /**
   * Where to resume: a cursor string (an SSE event's `id`, or `cursor()`) or
   * a map of channel to seq. A channel without a position starts at its head,
   * so it delivers only what is published from now on.
   */
  cursor?: string | ReadonlyMap<string, number> | Record<string, number> | null;
  /** Ends the subscription when it aborts. */
  signal?: AbortSignal;
};

/**
 * Change feeds: publish "channel K changed", and follow channels from a
 * cursor, in this process or any other sharing the driver's store.
 *
 * ```ts
 * await ChangeFeed.publish(`site:${site.id}`, { pages: ["/about"] });
 *
 * for await (const event of ChangeFeed.subscribe([`site:${site.id}`], { signal })) {
 *   // { type: "change", channel, seq, data } or { type: "reset", channel, seq }
 * }
 * ```
 *
 * The driver's log is the truth, and notifications only wake subscribers to
 * read it. A subscription keeps no queue of its own, only which of its
 * channels may have moved; it reads the log when its consumer asks for the
 * next event. So a slow consumer costs nothing while it is behind, and one
 * that fell further behind than the log keeps gets a `reset`.
 */
export class ChangeFeedManager {
  static token = "changeFeed";

  readonly driver: ChangeFeedDriver;
  readonly config: Required<ChangeFeedConfig>;
  private readonly followers = new Map<string, Set<ChangeFeedSubscription>>();
  private readonly all = new Set<ChangeFeedSubscription>();
  private listenState: "off" | "connecting" | "listening" | "retrying" | "closed" = "off";
  private listening: { close(): Promise<void> } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;

  constructor(
    config: ChangeFeedConfig = {},
    private readonly options: { application?: Application } = {},
  ) {
    this.config = withDefaults(changeFeedConfigDefaults(), config);
    this.driver = resolveDriver(this.config.driver, options.application);
  }

  /** How many subscriptions this process holds. */
  get subscriptions(): number {
    return this.all.size;
  }

  /** Whether this process is listening for other processes' publishes. */
  get isListening(): boolean {
    return this.listenState === "listening";
  }

  /**
   * Appends `data` (JSON, or nothing) to `channel` and wakes its subscribers,
   * here and on every instance sharing the store. Resolves to the new seq.
   *
   * Inside an ORM transaction nobody is woken before the commit, and nothing
   * is published if it rolls back. The database driver on Postgres writes on
   * the transaction itself; every other driver publishes after the commit,
   * and then this resolves to `null`, since the seq does not exist yet.
   */
  async publish(channel: string, data?: unknown): Promise<number | null> {
    assertChannel(channel);
    const payload = data === undefined ? null : data;
    if (currentTransaction() !== undefined && !this.driver.joinsTransaction?.()) {
      void afterCommit(async () => {
        this.wake(channel, await this.driver.publish(channel, payload));
      });
      return null;
    }
    const seq = await this.driver.publish(channel, payload);
    void afterCommit(() => this.wake(channel, seq));
    return seq;
  }

  /** The latest seq of `channel`, `0` before its first publish. */
  async head(channel: string): Promise<number> {
    assertChannel(channel);
    return (await this.driver.heads([channel])).get(channel) ?? 0;
  }

  /**
   * A cursor at the channels' heads, for a view to hand its client so the
   * client's subscription resumes from what the view showed rather than
   * from whenever it connected.
   */
  async cursor(channels: string | readonly string[]): Promise<string> {
    const list = channelList(channels);
    return encodeCursor(await this.driver.heads(list));
  }

  /**
   * Follows `channels` from `options.cursor`. Iterate it with `for await`;
   * breaking out, `close()`, or `options.signal` ends it. Throws
   * `ChangeFeedFullError` when this process holds `maxSubscriptions` already.
   */
  subscribe(channels: string | readonly string[], options: SubscribeOptions = {}) {
    const list = channelList(channels);
    if (this.all.size >= this.config.maxSubscriptions) {
      throw new ChangeFeedFullError(this.config.maxSubscriptions);
    }
    const subscription = new ChangeFeedSubscription(
      this,
      list,
      toPositions(options.cursor),
      this.config,
      options.signal,
    );
    this.all.add(subscription);
    for (const channel of list) {
      let set = this.followers.get(channel);
      if (!set) this.followers.set(channel, (set = new Set()));
      set.add(subscription);
    }
    this.startListening();
    this.startPolling();
    return subscription;
  }

  /**
   * An SSE response following `channels`, for a route handler that has
   * already decided the caller may read them:
   *
   * ```ts
   * "/sites/:siteId/changes": this.get(async (req: HttpRequest) => {
   *   const site = await Site.findUniqueOrThrow({ where: { publicId: req.params.siteId } });
   *   return ChangeFeed.stream(req, `site:${site.id}`);
   * }),
   * ```
   *
   * It resumes from the request's `Last-Event-ID`, ends when the client goes
   * away or the server starts shutting down, and answers `503` with a
   * `Retry-After` when this process holds `maxSubscriptions` already.
   */
  stream<T = unknown>(
    request: { rawRequest: Request } | Request,
    channels: string | readonly string[],
    options: StreamOptions = {},
  ): ChangeFeedResponse<T> {
    return changeFeedStream<T>(this, request, channelList(channels), options);
  }

  /** Ends every subscription and stops listening. For shutdown and tests. */
  async close(): Promise<void> {
    this.listenState = "closed";
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPolling();
    for (const subscription of this.all) subscription.close();
    const listening = this.listening;
    this.listening = null;
    await listening?.close();
    await this.driver.close?.();
  }

  /** @internal */
  forget(subscription: ChangeFeedSubscription) {
    if (!this.all.delete(subscription)) return;
    for (const channel of subscription.channels) {
      const set = this.followers.get(channel);
      set?.delete(subscription);
      if (set?.size === 0) this.followers.delete(channel);
    }
    if (this.all.size === 0) this.stopPolling();
  }

  /**
   * Reads the heads of every channel this process follows, in one query per
   * 500 channels, and wakes the subscribers that are behind. Runs every
   * `pollInterval` while there are subscriptions, and at once whenever
   * notifications may have been missed. Cheaper than each subscription
   * re-reading its own log: one query per process, whatever the number of
   * subscribers.
   */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        const channels = [...this.followers.keys()];
        for (let i = 0; i < channels.length; i += 500) {
          const heads = await this.driver.heads(channels.slice(i, i + 500));
          for (const [channel, seq] of heads) this.wake(channel, seq);
        }
      } catch (error) {
        console.error("[gemi] The change feed could not read its channels' heads.", error);
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollInterval);
    this.pollTimer.unref?.();
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Tells this process's subscribers of `channel` that it reached `seq`. */
  private wake(channel: string, seq: number) {
    for (const subscription of this.followers.get(channel) ?? []) subscription.moved(channel, seq);
  }

  private resync() {
    void this.poll();
  }

  private startListening() {
    if (this.listenState !== "off" || !this.driver.listen) return;
    void this.connect();
  }

  private async connect() {
    this.listenState = "connecting";
    this.retryTimer = null;
    try {
      const listening = await this.driver.listen!(
        (channel, seq) => this.wake(channel, seq),
        () => this.resync(),
      );
      if (this.listenState !== "connecting") {
        await listening.close();
        return;
      }
      this.listening = listening;
      this.listenState = "listening";
      this.backoffMs = MIN_BACKOFF_MS;
      // Whatever was published before the LISTEN took hold was not heard.
      this.resync();
    } catch (error) {
      if (this.listenState !== "connecting") return;
      console.error(
        `[gemi] The change feed could not listen for other instances' changes; retrying in ${this.backoffMs}ms.`,
        error,
      );
      this.listenState = "retrying";
      this.retryTimer = setTimeout(() => void this.connect(), this.backoffMs);
      this.retryTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

/**
 * One subscriber's view of its channels: where it is in each, which may have
 * moved, and the few events read from the log but not yet taken.
 */
export class ChangeFeedSubscription implements AsyncIterableIterator<ChangeFeedEvent> {
  readonly channels: readonly string[];
  /** What was delivered: the cursor. */
  private readonly positions = new Map<string, number>();
  /** What was read from the log, delivered or still in `pending`. */
  private readonly readTo = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly pending: ChangeFeedEvent[] = [];
  private started: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private closed = false;
  private readonly onAbort = () => this.close();

  constructor(
    private readonly manager: ChangeFeedManager,
    channels: readonly string[],
    positions: Map<string, number>,
    private readonly config: Required<ChangeFeedConfig>,
    private readonly signal?: AbortSignal,
  ) {
    this.channels = channels;
    for (const channel of channels) {
      const seq = positions.get(channel);
      if (seq !== undefined) {
        this.positions.set(channel, seq);
        this.readTo.set(channel, seq);
        this.dirty.add(channel);
      }
    }
    if (signal?.aborted) this.close();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  /** Where the subscription is, as a cursor string. Complete once `ready()` resolved. */
  get cursor(): string {
    return encodeCursor(this.positions);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Resolves once every channel has a position: the cursor's, or the head
   * when it had none. Called by the first `next()`; call it yourself to
   * read `cursor` before the first event.
   */
  ready(): Promise<void> {
    this.started ??= (async () => {
      const missing = this.channels.filter((channel) => !this.positions.has(channel));
      if (missing.length === 0) return;
      const heads = await this.manager.driver.heads(missing);
      // A publish heard while the heads were read marked its channel dirty,
      // and the read that follows finds it in the log, or finds nothing.
      for (const channel of missing) {
        const head = heads.get(channel) ?? 0;
        this.positions.set(channel, head);
        this.readTo.set(channel, head);
      }
    })();
    return this.started;
  }

  async next(): Promise<IteratorResult<ChangeFeedEvent>> {
    await this.ready();
    for (;;) {
      if (this.closed) return { done: true, value: undefined };
      const event = this.pending.shift();
      if (event) {
        this.positions.set(event.channel, event.seq);
        return { done: false, value: event };
      }
      const channel = this.dirty.values().next().value;
      if (channel !== undefined) {
        await this.read(channel);
        continue;
      }
      await this.idle();
    }
  }

  async return(): Promise<IteratorResult<ChangeFeedEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  /** Ends the subscription. A pending `next()` resolves `done`. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.manager.forget(this);
    this.wake();
  }

  /**
   * @internal `channel` reached `seq`. Before `ready()` set a position the
   * channel is marked anyway, and read from its head once it has one.
   */
  moved(channel: string, seq: number) {
    const position = this.readTo.get(channel);
    if (position !== undefined && seq === position) return;
    this.dirty.add(channel);
    this.wake();
  }

  private async read(channel: string) {
    const after = this.readTo.get(channel) ?? 0;
    this.dirty.delete(channel);
    const { batchSize } = this.config;
    const { entries, head, gap } = await this.manager.driver.read(channel, after, batchSize);
    if (this.closed) return;
    if (gap) {
      this.readTo.set(channel, head);
      this.pending.push({ type: "reset", channel, seq: head });
      return;
    }
    for (const entry of entries) {
      this.readTo.set(channel, entry.seq);
      this.pending.push({ type: "change", channel, seq: entry.seq, data: entry.data });
    }
    if (entries.length === batchSize) this.dirty.add(channel);
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeUp = resolve;
    });
  }

  private wake() {
    const wakeUp = this.wakeUp;
    this.wakeUp = null;
    wakeUp?.();
  }
}

function assertChannel(channel: string) {
  if (typeof channel !== "string" || channel === "" || channel.length > MAX_CHANNEL_LENGTH) {
    throw new Error(
      `A change feed channel is a string of 1 to ${MAX_CHANNEL_LENGTH} characters; got ${JSON.stringify(channel)}.`,
    );
  }
}

function channelList(channels: string | readonly string[]): string[] {
  const list = [...new Set(typeof channels === "string" ? [channels] : channels)];
  if (list.length === 0) throw new Error("A change feed subscription needs at least one channel.");
  for (const channel of list) assertChannel(channel);
  return list;
}

function toPositions(cursor: SubscribeOptions["cursor"]): Map<string, number> {
  if (cursor === undefined || cursor === null) return new Map();
  if (typeof cursor === "string") return decodeCursor(cursor);
  const entries = cursor instanceof Map ? [...cursor] : Object.entries(cursor);
  return decodeCursor(encodeCursor(new Map(entries as [string, number][])));
}

function resolveDriver(
  driver: Required<ChangeFeedConfig>["driver"],
  application: Application | undefined,
): ChangeFeedDriver {
  if (driver === "memory") return new MemoryChangeFeedDriver();
  if (driver === "database" || typeof driver === "function") {
    if (!application && (driver === "database" || driver.length > 0)) {
      throw new Error(
        "The change feed driver needs the application it belongs to, and this " +
          "ChangeFeedManager was built without one. Pass { application }.",
      );
    }
    if (driver === "database") {
      return new DatabaseChangeFeedDriver(application!.make(DatabaseManager));
    }
    return driver(application!);
  }
  if (typeof driver === "string") {
    throw new Error(
      `Unknown change feed driver "${driver}". The changeFeed slice's driver is ` +
        `"memory", "database", a ChangeFeedDriver, or a function returning one.`,
    );
  }
  return driver;
}
