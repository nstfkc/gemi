import { app } from "../../../foundation/app";
import { buildResult, windowStartFor } from "../slidingWindow";
import type { ConsumeParams, RateLimitResult } from "../types";
import { InMemoryRateLimiter } from "./InMemoryRateLimiterDriver";
import { RateLimiterDriver } from "./RateLimiterDriver";
import { RedisManager } from "../../redis/RedisManager";

/**
 * The slice of Bun's `RedisClient` this driver needs. Narrow on purpose: any
 * client exposing `send(command, args)` works, which keeps the driver testable
 * without a live server.
 */
export interface RateLimiterRedisClient {
  send(command: string, args: string[]): Promise<any>;
  /**
   * Bun's client says whether its connection is up. Optional: a client that
   * does not say is always sent to.
   */
  readonly connected?: boolean;
}

/**
 * How a call is answered when Redis cannot answer it:
 * - `"memory"`: counted by an in-process limiter (`fallback`), so each
 *   instance enforces the limit on its own until Redis is back. The outage
 *   costs precision (one budget per instance), never the limit.
 * - `"open"`: admitted, uncounted.
 * - `"closed"`: refused.
 */
export type RedisRateLimiterFailureMode = "memory" | "open" | "closed";

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
   * What a call gets when Redis fails, times out or is known to be down.
   * Default `"memory"`: the call is counted by `fallback`, so a Redis outage
   * degrades every limit to a per-instance one instead of turning it off
   * (`"open"`) or locking everyone out (`"closed"`). See
   * {@link RedisRateLimiterFailureMode}.
   */
  onRedisError?: RedisRateLimiterFailureMode;
  /**
   * The limiter that counts while Redis is down, with `onRedisError:
   * "memory"`. Default: a new `InMemoryRateLimiter` for this driver.
   */
  fallback?: RateLimiterDriver;
  /**
   * @deprecated Use `onRedisError`. `true` is `"open"`, `false` is
   * `"closed"`. Ignored when `onRedisError` is set.
   */
  failOpen?: boolean;
  /**
   * How long one `consume` may wait for Redis, in ms, before it gives up and
   * is answered as `onRedisError` says. Default `250`. Without it, a request
   * waits as long as the client does: up to the connect timeout and the
   * reconnect loop (10 to 30 s) while Redis is down, and with no limit when
   * Redis stops answering on an open connection. `0` turns it off.
   */
  timeout?: number;
  /**
   * Called with every Redis failure: a command that failed or timed out, and
   * each failed check (at most one a second) of whether Redis is back. By
   * default a line goes to `console.error`, at most once a minute, saying how
   * many calls were answered without Redis since the last one.
   */
  onError?: (error: unknown) => void;
}

/** What `onError` gets when a `consume` ran past `timeout`. */
export class RedisRateLimiterTimeoutError extends Error {
  readonly code = "ERR_RATE_LIMITER_TIMEOUT";

  constructor(timeout: number) {
    super(`RedisRateLimiter: Redis did not answer within ${timeout}ms.`);
    this.name = "RedisRateLimiterTimeoutError";
  }
}

/**
 * What `onError` gets when the client says its connection is down, so the
 * call was answered without sending anything to Redis.
 */
export class RedisRateLimiterDisconnectedError extends Error {
  readonly code = "ERR_RATE_LIMITER_DISCONNECTED";

  constructor() {
    super("RedisRateLimiter: the Redis client is not connected.");
    this.name = "RedisRateLimiterDisconnectedError";
  }
}

/** How often, at most, a down limiter checks whether Redis answers again. */
const PROBE_INTERVAL_MS = 1_000;
/** How often, at most, the default `onError` writes a line. */
const LOG_INTERVAL_MS = 60_000;

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
 *
 * ## When Redis fails
 *
 * A call that fails or times out is answered as `onRedisError` says (by
 * default, counted in memory), and the limiter then stops sending its script
 * until Redis answers again. While it is down, each call is answered at once
 * without touching Redis, and at most once a second one of them sends a `PING`
 * in the background; the first `PING` that answers puts the limiter back on
 * Redis.
 *
 * Not sending is what keeps an outage from being counted twice. Bun's client
 * queues the commands it is given while disconnected and runs them once it
 * reconnects, and a connection that stopped answering (a paused or partitioned
 * Redis) delivers what was written to it once it answers again. Either way the
 * increments of calls that were already answered from memory would land in
 * Redis on recovery, and every caller of the outage would start the next
 * window over budget. A `PING` is harmless to run late. What can still land
 * late is the few calls sent before the first failure was seen: at most
 * `timeout` worth of traffic.
 */
export class RedisRateLimiter extends RateLimiterDriver {
  private injectedClient?: RateLimiterRedisClient;
  private prefix: string;
  private mode: RedisRateLimiterFailureMode;
  private fallback: RateLimiterDriver;
  private timeout: number;
  private onError?: (error: unknown) => void;

  /** Cached `SCRIPT LOAD` result, so the script body is sent at most once. */
  private scriptSha: Promise<string> | null = null;

  /** Set by a failure; cleared by the first `PING` that answers. */
  private down = false;
  private probing = false;
  private lastProbeAt = 0;
  /**
   * Clients seen connected. A client that says it is not connected is skipped
   * only once it has been seen connected: a new one is still making its first
   * connection, and its first commands wait for it (bounded by `timeout`).
   */
  private seenConnected = new WeakSet<object>();

  /** For the default `onError`: when it last wrote, and what it left out since. */
  private loggedAt = -Infinity;
  private failuresSinceLog = 0;
  private fallbacksSinceLog = 0;

  constructor(options: RedisRateLimiterOptions = {}) {
    super();
    this.injectedClient = options.client;
    this.prefix = options.prefix ?? "gemi:rl";
    this.mode =
      options.onRedisError ??
      (options.failOpen === undefined
        ? "memory"
        : options.failOpen
          ? "open"
          : "closed");
    this.fallback = options.fallback ?? new InMemoryRateLimiter();
    this.timeout = options.timeout ?? 250;
    this.onError = options.onError;
  }

  async consume(params: ConsumeParams): Promise<RateLimitResult> {
    const { key, limit, window } = params;
    const cost = params.cost ?? 1;
    const now = Date.now();
    const windowStart = windowStartFor(now, window);
    const elapsed = now - windowStart;
    const bucket = windowStart / window;

    if (this.down) {
      this.probe();
      return this.degrade(params, now);
    }

    try {
      const client = this.client;
      if (client.connected === false && this.seenConnected.has(client)) {
        throw new RedisRateLimiterDisconnectedError();
      }

      const reply = await this.withTimeout(
        this.run(
          client,
          [
            `${this.prefix}:${key}:${bucket}`,
            `${this.prefix}:${key}:${bucket - 1}`,
          ],
          [String(limit), String(window), String(elapsed), String(cost)],
        ),
        () => {
          // A `SCRIPT LOAD` stuck on a connection that stopped answering would
          // otherwise be awaited by every later call: drop it, the next call
          // loads again.
          this.scriptSha = null;
        },
      );
      if (client.connected === true) this.seenConnected.add(client);

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
      if (!this.down) {
        this.down = true;
        this.lastProbeAt = Date.now();
      }
      this.report(error);
      return this.degrade(params, now);
    }
  }

  /** Answers a call Redis could not, as `onRedisError` says. */
  private async degrade(
    params: ConsumeParams,
    now: number,
  ): Promise<RateLimitResult> {
    const { limit, window } = params;
    const cost = params.cost ?? 1;
    this.fallbacksSinceLog += 1;

    if (this.mode === "memory") {
      return await this.fallback.consume(params);
    }

    if (this.mode === "closed") {
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
      resetAt: windowStartFor(now, window) + window,
      retryAfter: 0,
    };
  }

  /**
   * While down: sends a `PING`, at most one at a time and one a second, and
   * puts the limiter back on Redis once one answers. Never awaited by the call
   * that starts it, so that call is not slowed down.
   */
  private probe() {
    const now = Date.now();
    if (this.probing || now - this.lastProbeAt < PROBE_INTERVAL_MS) return;
    this.probing = true;
    this.lastProbeAt = now;

    const ping = async () => {
      const client = this.client;
      await this.withTimeout(
        client.send("PING", []),
        undefined,
        this.timeout > 0 ? this.timeout : PROBE_INTERVAL_MS,
      );
      if (client.connected === true) this.seenConnected.add(client);
    };

    ping().then(
      () => {
        this.probing = false;
        this.down = false;
        if (!this.onError) this.logRecovery();
      },
      (error) => {
        this.probing = false;
        try {
          this.report(error);
        } catch {
          // Nobody awaits the probe: an `onError` that throws has no caller to
          // reach, and must not become an unhandled rejection.
        }
      },
    );
  }

  private report(error: unknown) {
    if (this.onError) {
      this.onError(error);
      return;
    }

    this.failuresSinceLog += 1;
    const now = Date.now();
    if (now - this.loggedAt < LOG_INTERVAL_MS) return;

    const answered =
      this.mode === "memory"
        ? "counting in memory"
        : this.mode === "open"
          ? "admitting every request"
          : "refusing every request";
    const since =
      this.loggedAt === -Infinity
        ? ""
        : ` Since the last report: ${this.failuresSinceLog} failures, ${this.fallbacksSinceLog} calls answered without Redis.`;
    console.error(
      `[gemi] RedisRateLimiter: Redis failed, ${answered} until it answers again.${since}`,
      error,
    );
    this.loggedAt = now;
    this.failuresSinceLog = 0;
    this.fallbacksSinceLog = 0;
  }

  private logRecovery() {
    console.info(
      `[gemi] RedisRateLimiter: Redis answers again; counting in Redis (${this.fallbacksSinceLog} calls answered without it since the last report).`,
    );
    // The next outage is reported at once.
    this.loggedAt = -Infinity;
    this.failuresSinceLog = 0;
    this.fallbacksSinceLog = 0;
  }

  /**
   * Settles with `work`, or rejects with `RedisRateLimiterTimeoutError` once
   * `ms` passes. The command itself is not cancelled (Redis may still run the
   * script, so a request that timed out can still be counted); its late
   * outcome is ignored.
   */
  private withTimeout<T>(
    work: Promise<T>,
    onTimeout?: () => void,
    ms: number = this.timeout,
  ): Promise<T> {
    if (!(ms > 0) || !Number.isFinite(ms)) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new RedisRateLimiterTimeoutError(ms));
      }, ms);
    });
    work.catch(() => {});

    return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
  }

  private get client(): RateLimiterRedisClient {
    if (this.injectedClient) return this.injectedClient;

    // `bound` first: an application can use this driver with an injected
    // client and never register `RedisServiceProvider`, and `make` on an
    // unbound token throws rather than returning undefined.
    //
    // This used to resolve through a hand-forged `{ token: "redis" }` cast to
    // avoid importing `RedisManager` at all, because that module imported Bun's
    // `RedisClient` as a *value* and would have made this driver unloadable off
    // Bun. #403 turned that into an `import type`, so the class can be named
    // here and the cast is gone with it.
    const container = app();
    const client = container.bound(RedisManager)
      ? container.make(RedisManager).client
      : undefined;

    if (!client) {
      throw new Error(
        "RedisRateLimiter could not reach the Redis client. Register RedisServiceProvider on your application, or pass a client: new RedisRateLimiter({ client }).",
      );
    }
    return client;
  }

  /** Runs the script by digest, loading it on first use and after a flush. */
  private async run(
    client: RateLimiterRedisClient,
    keys: string[],
    args: string[],
  ): Promise<any> {
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
