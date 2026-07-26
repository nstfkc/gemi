import type { ServiceToken } from "../../../container/Container";
import { app } from "../../../foundation/app";
import { buildResult, windowStartFor } from "../slidingWindow";
import type { ConsumeParams, RateLimitResult } from "../types";
import { RateLimiterDriver } from "./RateLimiterDriver";

/**
 * The slice of Bun's `RedisClient` this driver needs. Narrow on purpose: any
 * client exposing `send(command, args)` works, which keeps the driver testable
 * without a live server.
 */
export interface RateLimiterRedisClient {
  send(command: string, args: string[]): Promise<any>;
}

/**
 * Stands in for `RedisManager` — same token string, so the container hands back
 * the very same singleton — without importing the class. See `client` below for
 * why the import has to be avoided.
 */
const REDIS_TOKEN = { token: "redis" } as unknown as ServiceToken<{
  client: RateLimiterRedisClient;
}>;

export interface RedisRateLimiterOptions {
  /**
   * Client to run against. Defaults to the app's shared client from
   * `RedisServiceProvider`, resolved lazily so constructing the driver never
   * requires a kernel or a connection.
   */
  client?: RateLimiterRedisClient;
  /** Key namespace. Defaults to `gemi:rl`. */
  prefix?: string;
  /**
   * What to do when Redis is unreachable. `true` (the default) admits the
   * request — a limiter outage should not take the site down with it. Set
   * `false` for endpoints where an unmetered request is worse than a rejected
   * one (payments, sign-up, anything that costs money per call).
   */
  failOpen?: boolean;
  /** Called with every Redis failure. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

/**
 * The counters and the decision have to move together — a GET, a check, then an
 * INCR from the app would let concurrent requests read the same count and all
 * conclude they fit. This script does the whole sliding-window step inside
 * Redis, which is single-threaded, so the read-decide-write is atomic.
 *
 * Only integers cross the boundary: Lua converts numbers to integers on the way
 * out, so the weighted (fractional) usage stays inside the script and the JS
 * side rebuilds the result from the raw counts.
 */
const CONSUME_SCRIPT = `
local currentKey = KEYS[1]
local previousKey = KEYS[2]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local current = tonumber(redis.call("GET", currentKey)) or 0
local previous = tonumber(redis.call("GET", previousKey)) or 0

local weight = (window - elapsed) / window
if weight < 0 then weight = 0 end
if weight > 1 then weight = 1 end

local usage = previous * weight + current

if usage + cost > limit then
  return {0, current, previous}
end

current = redis.call("INCRBY", currentKey, cost)
-- Two windows of lifetime: the key still has to be readable as "previous"
-- while the next window is running.
redis.call("PEXPIRE", currentKey, window * 2)

return {1, current, previous}
`;

/**
 * Rate limiter backed by Redis, so every instance of the app counts against the
 * same budget. Use it as soon as you run more than one process.
 *
 * ```ts
 * // app/config/ratelimiter.ts
 * import { defineRateLimiterConfig, RedisRateLimiter } from "gemi/services";
 *
 * export default defineRateLimiterConfig({
 *   driver: new RedisRateLimiter(),
 * });
 * ```
 *
 * Window boundaries come from the app server's clock, not Redis's, so keep
 * instances on NTP. A few seconds of skew only shifts where a window starts; it
 * cannot double a budget the way an unsynchronised fixed window would.
 */
export class RedisRateLimiter extends RateLimiterDriver {
  private injectedClient?: RateLimiterRedisClient;
  private prefix: string;
  private failOpen: boolean;
  private onError: (error: unknown) => void;

  /** Cached `SCRIPT LOAD` result, so the script body is sent at most once. */
  private scriptSha: Promise<string> | null = null;

  constructor(options: RedisRateLimiterOptions = {}) {
    super();
    this.injectedClient = options.client;
    this.prefix = options.prefix ?? "gemi:rl";
    this.failOpen = options.failOpen ?? true;
    this.onError = options.onError ?? ((error) => console.error(error));
  }

  async consume(params: ConsumeParams): Promise<RateLimitResult> {
    const { key, limit, window } = params;
    const cost = params.cost ?? 1;
    const now = Date.now();
    const windowStart = windowStartFor(now, window);
    const elapsed = now - windowStart;
    const bucket = windowStart / window;

    try {
      const reply = await this.run(
        [
          `${this.prefix}:${key}:${bucket}`,
          `${this.prefix}:${key}:${bucket - 1}`,
        ],
        [String(limit), String(window), String(elapsed), String(cost)],
      );

      const [allowed, current, previous] = (
        Array.isArray(reply) ? reply : []
      ).map(Number);

      return buildResult({
        allowed: allowed === 1,
        current: Number.isFinite(current) ? current : 0,
        previous: Number.isFinite(previous) ? previous : 0,
        now,
        elapsed,
        window,
        limit,
        cost,
      });
    } catch (error) {
      this.onError(error);

      if (!this.failOpen) {
        return {
          allowed: false,
          limit,
          remaining: 0,
          // Nothing was counted, so there is no decay to wait for — retrying is
          // worth it as soon as Redis is back.
          resetAt: now + window,
          retryAfter: window,
        };
      }

      return {
        allowed: true,
        limit,
        remaining: Math.max(0, Math.floor(limit - cost)),
        resetAt: windowStart + window,
        retryAfter: 0,
      };
    }
  }

  private get client(): RateLimiterRedisClient {
    if (this.injectedClient) return this.injectedClient;

    // Resolved through a locally declared token rather than by importing
    // `RedisManager`: that module imports Bun's `RedisClient` as a value, and
    // importing it here would make this driver — and anything that re-exports
    // it — unloadable outside the Bun runtime. The container keys bindings off
    // the token string, so this resolves the same singleton the real class does.
    const container = app();
    const client = container.bound(REDIS_TOKEN)
      ? container.make(REDIS_TOKEN).client
      : undefined;

    if (!client) {
      throw new Error(
        "RedisRateLimiter could not reach the Redis client. Register RedisServiceProvider on your application, or pass a client: new RedisRateLimiter({ client }).",
      );
    }
    return client;
  }

  /** Runs the script by digest, loading it on first use and after a flush. */
  private async run(keys: string[], args: string[]): Promise<any> {
    const client = this.client;
    const argv = [String(keys.length), ...keys, ...args];

    try {
      return await client.send("EVALSHA", [await this.load(client), ...argv]);
    } catch (error) {
      // The server restarted or someone ran SCRIPT FLUSH between our load and
      // this call. Re-load once and retry; a second failure is a real error.
      if (!isNoScriptError(error)) throw error;
      this.scriptSha = null;
      return await client.send("EVALSHA", [await this.load(client), ...argv]);
    }
  }

  private load(client: RateLimiterRedisClient) {
    if (!this.scriptSha) {
      this.scriptSha = Promise.resolve(
        client.send("SCRIPT", ["LOAD", CONSUME_SCRIPT]),
      )
        .then(String)
        .catch((error) => {
          // Never cache a rejection — the next request must be free to retry.
          this.scriptSha = null;
          throw error;
        });
    }
    return this.scriptSha;
  }
}

function isNoScriptError(error: unknown) {
  return String((error as Error)?.message ?? error).includes("NOSCRIPT");
}
