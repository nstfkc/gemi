import { randomBytes } from "node:crypto";
import type { RedisOptions } from "bun";

import type {
  BroadcastDeliver,
  BroadcastDriver,
  BroadcastDriverHooks,
  BroadcastRevocation,
} from "./BroadcastDriver";

/**
 * The part of a Redis client the driver uses: Bun's `RedisClient` has it.
 * Described structurally so tests can hand in a fake (`createClient`).
 */
export interface RedisPubSubClient {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<number>;
  /** Without a listener: drops the channel and every listener on it. */
  unsubscribe(channel: string): Promise<void>;
  ping(): Promise<unknown>;
  close(): void;
  onclose: ((error: Error) => void) | null;
}

export interface RedisBroadcastDriverOptions {
  /** Defaults to `app/config/redis.ts`'s `url`, then `REDIS_URL`. */
  url?: string;
  /** Bun `RedisClient` options. Defaults to `app/config/redis.ts`'s `options`. */
  options?: RedisOptions;
  /** Prepended to every topic to name its Redis channel. Default `"gemi:bc:"`. */
  prefix?: string;
  /**
   * How long a first socket's subscription may wait for Redis before it is
   * denied with `error` (the client retries it). Default `5000`.
   */
  subscribeTimeoutMs?: number;
  /**
   * How often the subscriber connection is pinged, in ms. A ping that fails
   * or goes unanswered for `subscribeTimeoutMs` drops the connection, which
   * is reconnected (and sockets told `gap`): a connection a proxy cut
   * silently would otherwise stay subscribed to nothing. `0` turns it off.
   * Default `30000`.
   */
  healthCheckMs?: number;
  /** Builds a client. Default: `new Bun.RedisClient(url, options)`. */
  createClient?: (role: "publisher" | "subscriber") => RedisPubSubClient;
}

/** A message on the control channel. */
interface ControlMessage {
  op: "revoke";
  /** The process that sent it; it applied the revocation itself. */
  from: string;
  r: BroadcastRevocation;
}

const DEFAULT_PREFIX = "gemi:bc:";
/** Appended to the prefix: a segment no topic can have (`__` is reserved). */
const CONTROL_CHANNEL = "__control";
const MIN_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 10_000;
/** How long opening and subscribing a subscriber connection may take. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Broadcast over Redis pub/sub: an emit reaches the sockets of every process
 * of the app, `gemi queue:work` workers' emits included.
 *
 * - **Publishing.** Every emit is `PUBLISH`ed on `<prefix><topic>`, from a
 *   publisher connection opened on the first emit. A process without the
 *   HTTP server (a worker) only ever has this one.
 * - **Receiving.** A process that serves sockets has one subscriber
 *   connection. It `SUBSCRIBE`s to a topic when the first local socket joins
 *   it and `UNSUBSCRIBE`s when the last leaves, so a process receives only the
 *   topics its sockets are on. It delivers what it receives, its own emits
 *   included: one delivery path, nothing delivered twice.
 * - **Revocations** travel on `<prefix>__control`, and every process applies
 *   them. The process that revokes applies it at once too, so its own sockets
 *   are covered while Redis is unreachable.
 * - **Reconnects.** When the subscriber connection drops, the driver opens a
 *   new one with backoff, subscribes every topic again, and then tells the
 *   transport (`onGap`), which sends its sockets `{op:"gap"}` so clients
 *   refetch what they may have missed.
 *
 * Needs `SECRET`: a `toOthers` frame names the skipped socket by a tag keyed
 * from it, which every process must compute alike.
 */
export class RedisBroadcastDriver implements BroadcastDriver {
  readonly prefix: string;
  private readonly controlChannel: string;
  private readonly instanceId = randomBytes(9).toString("base64url");
  private readonly subscribeTimeoutMs: number;
  private readonly healthCheckMs: number;

  private publisher: RedisPubSubClient | null = null;
  private subscriber: RedisPubSubClient | null = null;
  /** Resolves with the subscriber once it is connected and subscribed. */
  private ready: Promise<RedisPubSubClient> | null = null;
  private deliver: BroadcastDeliver | null = null;
  private hooks: BroadcastDriverHooks | undefined;
  /** Topics with local sockets: the ones the subscriber should be on. */
  private readonly wanted = new Set<string>();
  /** Topics the current subscriber connection is subscribed to. */
  private readonly active = new Set<string>();
  /** Per topic, the tail of its SUBSCRIBE/UNSUBSCRIBE chain. */
  private readonly chains = new Map<string, Promise<void>>();
  private connectedOnce = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly config: RedisBroadcastDriverOptions = {}) {
    this.prefix = config.prefix ?? DEFAULT_PREFIX;
    this.controlChannel = this.prefix + CONTROL_CHANNEL;
    this.subscribeTimeoutMs = config.subscribeTimeoutMs ?? 5_000;
    this.healthCheckMs = config.healthCheckMs ?? 30_000;
  }

  /** Whether the subscriber connection is up and subscribed. */
  get connected(): boolean {
    return this.subscriber !== null && this.ready === null;
  }

  publish(topic: string, frame: string): Promise<void> {
    return this.send(this.prefix + topic, frame);
  }

  /**
   * Applies the revocation here at once, then sends it to every other
   * process. Another process whose subscriber is down while it is sent does
   * not see it; see the docs.
   */
  async revoke(revocation: BroadcastRevocation): Promise<void> {
    this.hooks?.onRevoke?.(revocation);
    const message: ControlMessage = { op: "revoke", from: this.instanceId, r: revocation };
    await this.send(this.controlChannel, JSON.stringify(message));
  }

  /**
   * Opens the subscriber connection. Resolves once it is connected, or at
   * `subscribeTimeoutMs` when Redis is unreachable, in which case it keeps
   * trying in the background: the HTTP server does not wait on Redis to
   * boot.
   */
  async start(deliver: BroadcastDeliver, hooks?: BroadcastDriverHooks): Promise<void> {
    this.closed = false;
    this.deliver = deliver;
    this.hooks = hooks;
    this.connectSubscriber();
    this.startHealthCheck();
    try {
      await this.whenReady();
    } catch {
      console.warn(`[gemi] Broadcast: Redis is not reachable yet; sockets get events once it is.`);
    }
  }

  topicAdded(topic: string): Promise<void> {
    this.wanted.add(topic);
    return this.sync(topic, true);
  }

  topicRemoved(topic: string): Promise<void> {
    this.wanted.delete(topic);
    return this.sync(topic, false);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.deliver = null;
    this.hooks = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const clients = [this.subscriber, this.publisher];
    this.subscriber = null;
    this.publisher = null;
    this.ready = null;
    this.wanted.clear();
    this.active.clear();
    this.chains.clear();
    for (const client of clients) {
      if (!client) continue;
      client.onclose = null;
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }

  private async send(channel: string, message: string): Promise<void> {
    await this.publisherClient().publish(channel, message);
  }

  /**
   * The publisher, built on first use. Bun's client reconnects it on its
   * own; one that has given up (`onclose`) is replaced on the next publish.
   */
  private publisherClient(): RedisPubSubClient {
    if (this.publisher) return this.publisher;
    const client = this.createClient("publisher");
    client.onclose = () => {
      if (this.publisher === client) this.publisher = null;
    };
    this.publisher = client;
    return client;
  }

  private createClient(role: "publisher" | "subscriber"): RedisPubSubClient {
    if (this.config.createClient) return this.config.createClient(role);
    const ctor = (globalThis as any).Bun?.RedisClient as
      | (new (url?: string, options?: RedisOptions) => RedisPubSubClient)
      | undefined;
    if (typeof ctor !== "function") {
      throw new Error(
        "The redis broadcast driver needs Bun's built-in Redis client. Run the app under Bun.",
      );
    }
    // The subscriber reconnects itself (`connectSubscriber`): Bun's own
    // reconnect does not restore subscriptions, and gives up for good after
    // its retries. The publisher keeps the app's settings.
    const options: RedisOptions =
      role === "subscriber"
        ? { ...this.config.options, autoReconnect: false }
        : { ...this.config.options };
    return new ctor(this.config.url, options);
  }

  /**
   * Opens a subscriber connection and subscribes the control channel and
   * every wanted topic on it. On failure, or when it drops later, the next
   * one is tried with backoff. Every connection after the first reports a
   * gap, once it is subscribed: what was published in between is lost.
   */
  private connectSubscriber() {
    if (this.closed || this.ready) return;
    let client: RedisPubSubClient;
    try {
      client = this.createClient("subscriber");
    } catch (error) {
      console.error("[gemi] Broadcast: the Redis subscriber could not be created.", error);
      this.scheduleReconnect();
      return;
    }
    this.subscriber = client;
    this.active.clear();
    client.onclose = () => this.lost(client);
    const ready = withTimeout(
      (async () => {
        await client.connect();
        await client.subscribe(this.controlChannel, this.onMessage);
        const topics = [...this.wanted];
        await Promise.all(
          topics.map((topic) => client.subscribe(this.prefix + topic, this.onMessage)),
        );
        if (this.subscriber !== client) throw new Error("Replaced.");
        for (const topic of topics) this.active.add(topic);
        return client;
      })(),
      CONNECT_TIMEOUT_MS,
      "connect",
    );
    this.ready = ready;
    ready.then(
      () => {
        if (this.subscriber !== client) return;
        this.ready = null;
        this.reconnectAttempt = 0;
        // Topics that left while this connection subscribed them.
        for (const topic of this.active) {
          if (!this.wanted.has(topic)) void this.sync(topic, false).catch(() => {});
        }
        if (this.connectedOnce) this.hooks?.onGap?.();
        this.connectedOnce = true;
      },
      (error) => {
        if (this.subscriber !== client || this.closed) return;
        console.warn(
          `[gemi] Broadcast: the Redis subscriber could not connect (${messageOf(error)}); retrying.`,
        );
        this.drop(client);
      },
    );
  }

  /** The subscriber connection closed under it. */
  private lost(client: RedisPubSubClient) {
    if (this.subscriber !== client || this.closed) return;
    if (this.ready === null) {
      console.warn("[gemi] Broadcast: the Redis subscriber connection dropped; reconnecting.");
    }
    this.drop(client);
  }

  private drop(client: RedisPubSubClient) {
    if (this.subscriber !== client) return;
    this.subscriber = null;
    this.ready = null;
    this.active.clear();
    client.onclose = null;
    try {
      client.close();
    } catch {
      // Already closed.
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const cap = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 16);
    const delay = Math.max(MIN_RECONNECT_MS, Math.floor(Math.random() * cap));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSubscriber();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private startHealthCheck() {
    if (this.healthCheckMs <= 0 || this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      const client = this.subscriber;
      if (!client || this.ready) return;
      withTimeout(client.ping(), this.subscribeTimeoutMs, "ping").catch((error) => {
        if (this.subscriber !== client) return;
        console.warn(
          `[gemi] Broadcast: the Redis subscriber did not answer a ping (${messageOf(error)}); reconnecting.`,
        );
        this.drop(client);
      });
    }, this.healthCheckMs);
    (this.healthTimer as { unref?: () => void }).unref?.();
  }

  /** The connected subscriber, waiting up to `subscribeTimeoutMs` for one. */
  private async whenReady(): Promise<RedisPubSubClient> {
    if (this.closed) throw new Error("The broadcast driver is closed.");
    const deadline = Date.now() + this.subscribeTimeoutMs;
    for (;;) {
      if (this.subscriber && !this.ready) return this.subscriber;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Redis did not answer in time.");
      // Between two attempts there is nothing to wait on but the timer.
      const pending: Promise<unknown> = this.ready ?? sleep(Math.min(left, MIN_RECONNECT_MS));
      await withTimeout(pending, left, "subscribe").catch((error) => {
        if (Date.now() >= deadline) throw error;
      });
    }
  }

  /**
   * Brings the subscription to `topic` in line with `wanted`, after whatever
   * was already queued for it: a socket leaving and another joining in the
   * next tick become UNSUBSCRIBE then SUBSCRIBE, in that order.
   */
  private sync(topic: string, joining: boolean): Promise<void> {
    const previous = this.chains.get(topic) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.reconcile(topic, joining));
    this.chains.set(topic, next);
    const forget = () => {
      if (this.chains.get(topic) === next) this.chains.delete(topic);
    };
    next.then(forget, forget);
    return next;
  }

  private async reconcile(topic: string, joining: boolean): Promise<void> {
    const want = this.wanted.has(topic);
    if (!want) {
      // Leaving needs no connection: a new one subscribes only what is wanted.
      if (!this.active.has(topic) || !this.connected) return;
      const client = this.subscriber!;
      this.active.delete(topic);
      await client.unsubscribe(this.prefix + topic);
      return;
    }
    // Wanted again by a join queued behind this leave, which subscribes it.
    if (!joining) return;
    const client = await this.whenReady();
    if (!this.wanted.has(topic) || this.active.has(topic)) return;
    try {
      await withTimeout(
        client.subscribe(this.prefix + topic, this.onMessage),
        this.subscribeTimeoutMs,
        "subscribe",
      );
    } catch (error) {
      // A SUBSCRIBE still in flight may land later and add a second listener
      // when the topic is subscribed again: start over on a new connection,
      // which subscribes what is wanted once.
      if (this.subscriber === client) this.drop(client);
      throw error;
    }
    if (this.subscriber === client) this.active.add(topic);
  }

  private readonly onMessage = (message: string, channel: string) => {
    if (channel === this.controlChannel) {
      this.onControl(message);
      return;
    }
    if (!channel.startsWith(this.prefix)) return;
    this.deliver?.(channel.slice(this.prefix.length), message);
  };

  private onControl(message: string) {
    let control: ControlMessage;
    try {
      control = JSON.parse(message);
    } catch {
      return;
    }
    if (control?.op !== "revoke" || control.from === this.instanceId) return;
    const r = control.r as Partial<{ user: unknown; topic: unknown }> | undefined;
    if (r && typeof r.user === "string") this.hooks?.onRevoke?.({ user: r.user });
    else if (r && typeof r.topic === "string") this.hooks?.onRevoke?.({ topic: r.topic });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis ${what} timed out after ${ms} ms.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
