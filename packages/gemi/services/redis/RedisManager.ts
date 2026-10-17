import type { RedisClient, RedisOptions } from "bun";
import type { RedisConfig } from "./config";

/**
 * The constructor `Bun.RedisClient` is, described structurally.
 *
 * Reached through the `Bun` global rather than `import { RedisClient } from
 * "bun"`, which is what this module used to do. That was a **value** import of
 * a specifier only the Bun runtime can resolve, and this class is re-exported
 * from `gemi/services` and reached from `gemi/facades` through the `Redis`
 * facade — the two barrels that are also the only door to `CronJob`, `Job`,
 * `DB` and `Lang`. So the specifier landed in the graph of every app and every
 * test that imported either one, and under a browser-targeted runner the whole
 * barrel simply failed to resolve (#396, #403).
 *
 * The global carries no specifier for a bundler or a test runner to resolve, so
 * the cost is paid only by code that actually asks for a client.
 */
type RedisClientConstructor = new (
  url?: string,
  options?: RedisOptions,
) => RedisClient;

/** First wait before replacing a client that is down. */
const REPLACE_MIN_DELAY_MS = 500;
/** Longest wait between two replacements while Redis stays down. */
const REPLACE_MAX_DELAY_MS = 10_000;
/** How long past its `connectionTimeout` a connect may stay pending before it counts as failed. */
const CONNECT_GRACE_MS = 5_000;
/** Bun's default `connectionTimeout`. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export class RedisManager {
  static token = "redis";

  private instance: RedisClient | null = null;

  /** When the connect the manager started on `instance` began, while it is pending. */
  private connectingSince: number | null = null;
  /** When `instance` was first seen down, after its connect settled. */
  private downSince: number | null = null;
  /** How long a client must be down before it is replaced. */
  private replaceDelay = REPLACE_MIN_DELAY_MS;

  constructor(public config: RedisConfig = {}) {}

  /**
   * Bun's Redis client. Built on first access and memoized; building it starts
   * the connection, which the first command would do anyway.
   *
   * Once Bun's client gives up on a connection (a connect timeout, or
   * `maxRetries` reconnects in a row) it never connects again, and every later
   * command fails at once with `Connection has failed`, even after Redis is
   * back (#982); calling its `connect()` again can hang. So an access that
   * finds the client down replaces it: the old one is closed and a new one
   * built. A client is down when it is not connected and no connect the
   * manager started on it is still pending. It gets a grace period first, so a
   * blip that Bun's own reconnect covers costs nothing: 0.5 s, doubling with
   * each replacement that does not connect, up to 10 s, and back to 0.5 s once
   * one connects. So a Redis that stays down is tried at most every 10 s.
   *
   * Read `client` each time rather than keeping it: a kept reference can be a
   * client that was replaced and closed.
   */
  get client(): RedisClient {
    if (this.instance === null) return this.build();

    const client = this.instance;
    if (this.isDown(client, Date.now())) {
      this.instance = null;
      try {
        client.close();
      } catch {}
      return this.build();
    }
    return client;
  }

  /**
   * `client` was a plain public property before it was a getter, and
   * overwriting a manager's client is how this repo fakes one —
   * `S3Driver.test.ts` does exactly that, and the `S3Driver` half of #403 kept
   * that seam working on purpose. An accessor with no setter would have turned
   * `manager.client = fake` into `TypeError: Attempted to assign to readonly
   * property` instead, which is not a change this was meant to make.
   */
  set client(client: RedisClient) {
    this.instance = client;
    this.connectingSince = null;
    this.downSince = null;
    this.replaceDelay = REPLACE_MIN_DELAY_MS;
  }

  /**
   * Closes the client, when one was built; a later `client` builds a new one.
   * Does not build one to close it.
   */
  close(): void {
    const client = this.instance;
    this.instance = null;
    this.connectingSince = null;
    this.downSince = null;
    this.replaceDelay = REPLACE_MIN_DELAY_MS;
    client?.close();
  }

  private build(): RedisClient {
    const client = new (redisClientConstructor())(
      this.config.url,
      this.config.options,
    );
    this.instance = client;
    this.downSince = null;
    this.connectingSince = null;

    // Only Bun's client can say whether it connected; a stand-in without
    // `connect()` is never replaced.
    if (typeof client.connect === "function") {
      this.connectingSince = Date.now();
      let connecting: Promise<unknown>;
      try {
        connecting = Promise.resolve(client.connect());
      } catch (error) {
        connecting = Promise.reject(error);
      }
      connecting.then(
        () => {
          if (this.instance !== client) return;
          this.connectingSince = null;
          this.replaceDelay = REPLACE_MIN_DELAY_MS;
        },
        () => {
          // The commands waiting on this connection report the failure to
          // their callers; here it only makes the client a candidate for
          // replacement.
          if (this.instance !== client) return;
          this.connectingSince = null;
        },
      );
    }
    return client;
  }

  private isDown(client: RedisClient, now: number): boolean {
    if (client.connected !== false || typeof client.connect !== "function") {
      this.downSince = null;
      return false;
    }

    if (this.connectingSince !== null) {
      const limit =
        (this.config.options?.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS) +
        CONNECT_GRACE_MS;
      if (now - this.connectingSince < limit) return false;
      // A connect that outlived its own timeout is not coming back.
      this.connectingSince = null;
    }

    this.downSince ??= now;
    if (now - this.downSince < this.replaceDelay) return false;

    this.replaceDelay = Math.min(this.replaceDelay * 2, REPLACE_MAX_DELAY_MS);
    return true;
  }
}

function redisClientConstructor(): RedisClientConstructor {
  const ctor = (globalThis as any).Bun?.RedisClient as
    | RedisClientConstructor
    | undefined;

  if (typeof ctor !== "function") {
    throw new Error(
      "Redis requires Bun's built-in Redis client, which this runtime does not provide. Run the app under Bun, or bind your own client for the 'redis' token.",
    );
  }

  return ctor;
}
