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

export class RedisManager {
  static token = "redis";

  private instance: RedisClient | null = null;

  constructor(public config: RedisConfig = {}) {}

  /**
   * Bun's Redis client. Built on first access and memoized.
   *
   * It connects lazily on the first command, so building it here is safe even
   * when Redis isn't running or configured — nothing connects until something
   * actually issues a command.
   */
  get client(): RedisClient {
    return (this.instance ??= new (redisClientConstructor())(
      this.config.url,
      this.config.options,
    ));
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
