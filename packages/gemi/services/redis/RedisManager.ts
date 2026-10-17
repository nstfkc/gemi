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

/** First wait between two revival attempts while Redis stays unreachable. */
const REVIVE_MIN_DELAY_MS = 500;
/** Longest wait between two revival attempts. */
const REVIVE_MAX_DELAY_MS = 10_000;

export class RedisManager {
  static token = "redis";

  private instance: RedisClient | null = null;

  /** The revival attempt in flight, so concurrent accesses share it. */
  private reviving: Promise<unknown> | null = null;
  /** Earliest time the next revival attempt may start. */
  private nextReviveAt = 0;
  /** Wait applied after the next failed revival attempt. */
  private reviveDelay = REVIVE_MIN_DELAY_MS;

  constructor(public config: RedisConfig = {}) {}

  /**
   * Bun's Redis client. Built on first access and memoized.
   *
   * It connects lazily on the first command, so building it here is safe even
   * when Redis isn't running or configured — nothing connects until something
   * actually issues a command.
   *
   * Once Bun's client gives up on a connection (a connect timeout, or
   * `maxRetries` reconnects in a row) it never connects again on its own, and
   * every later command fails at once with `Connection has failed`, even after
   * Redis is back (#982). So a later access that finds the client disconnected
   * calls its `connect()` again, which brings the same client back: anything
   * holding on to it (a `Redis.client` kept by app code, a subscription) keeps
   * working. Attempts are spaced out with a backoff (0.5 s doubling to 10 s,
   * reset once one succeeds) so a Redis that stays down isn't hammered, and
   * one attempt at a time is in flight.
   */
  get client(): RedisClient {
    const built = this.instance === null;
    const client = (this.instance ??= new (redisClientConstructor())(
      this.config.url,
      this.config.options,
    ));
    // A client just built has not tried to connect yet; its first command
    // does that.
    if (!built) this.reviveIfDisconnected(client);
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
    this.resetRevival();
  }

  /**
   * Closes the client, when one was built; a later `client` builds a new one.
   * Does not build one to close it.
   */
  close(): void {
    const client = this.instance;
    this.instance = null;
    this.resetRevival();
    client?.close();
  }

  private reviveIfDisconnected(client: RedisClient) {
    // Only Bun's client says whether it is connected; a fake that doesn't is
    // left alone.
    if (client.connected !== false || typeof client.connect !== "function") {
      return;
    }
    if (this.reviving || Date.now() < this.nextReviveAt) return;

    let connecting: Promise<unknown>;
    try {
      connecting = Promise.resolve(client.connect());
    } catch (error) {
      connecting = Promise.reject(error);
    }

    const attempt = connecting
      .then(
        () => {
          if (this.instance !== client) return;
          this.reviveDelay = REVIVE_MIN_DELAY_MS;
          this.nextReviveAt = 0;
        },
        () => {
          // The command that triggered this attempt reports the failure to its
          // caller; this one only schedules the next attempt.
          if (this.instance !== client) return;
          this.nextReviveAt = Date.now() + this.reviveDelay;
          this.reviveDelay = Math.min(this.reviveDelay * 2, REVIVE_MAX_DELAY_MS);
        },
      )
      .finally(() => {
        if (this.reviving === attempt) this.reviving = null;
      });
    this.reviving = attempt;
  }

  private resetRevival() {
    this.reviving = null;
    this.nextReviveAt = 0;
    this.reviveDelay = REVIVE_MIN_DELAY_MS;
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
