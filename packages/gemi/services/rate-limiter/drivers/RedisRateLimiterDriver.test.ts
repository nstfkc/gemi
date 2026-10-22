import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../../foundation/Application";
import { kernelContext } from "../../../kernel/context";
import { RedisManager } from "../../redis/RedisManager";
import { InMemoryRateLimiter } from "./InMemoryRateLimiterDriver";
import {
  RedisRateLimiter,
  RedisRateLimiterDisconnectedError,
  RedisRateLimiterTimeoutError,
} from "./RedisRateLimiterDriver";

type Reply = any | Error | ((args: string[]) => any);

/**
 * A stand-in for Bun's `RedisClient`, so these tests never need a server. It
 * records every command and answers from a programmable queue.
 */
function fakeRedis(
  options: {
    load?: Reply;
    /** Reply to every EVALSHA. */
    evalsha?: Reply;
    /** Reply to consecutive EVALSHAs, for testing retries. Wins over `evalsha`. */
    evalshaQueue?: Reply[];
    /** Reply to every PING. */
    ping?: Reply;
  } = {},
) {
  const calls: { command: string; args: string[] }[] = [];
  const evalshaReplies = options.evalshaQueue
    ? [...options.evalshaQueue]
    : undefined;

  function resolve(reply: Reply, args: string[]) {
    const value = typeof reply === "function" ? reply(args) : reply;
    if (value instanceof Error) throw value;
    return value;
  }

  return {
    calls,
    /** What Bun's client reports; `undefined` like a client that does not say. */
    connected: undefined as boolean | undefined,
    evalshaCalls: () => calls.filter((call) => call.command === "EVALSHA"),
    loadCalls: () => calls.filter((call) => call.command === "SCRIPT"),
    pingCalls: () => calls.filter((call) => call.command === "PING"),
    async send(command: string, args: string[]) {
      calls.push({ command, args });

      if (command === "SCRIPT") {
        return resolve(options.load ?? "sha-1", args);
      }

      if (command === "EVALSHA") {
        const reply = evalshaReplies
          ? (evalshaReplies.shift() ?? [1, 1, 0])
          : (options.evalsha ?? [1, 1, 0]);
        return resolve(reply, args);
      }

      if (command === "PING") {
        return resolve(options.ping ?? "PONG", args);
      }

      return null;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60_400);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consume", () => {
  test("runs the script against the current and previous window keys", async () => {
    const client = fakeRedis();
    const limiter = new RedisRateLimiter({ client });

    await limiter.consume({ key: "1.2.3.4:/api/x", limit: 10, window: 1000 });

    const [call] = client.evalshaCalls();
    expect(call.args).toEqual([
      "sha-1",
      "2",
      "gemi:rl:1.2.3.4:/api/x:60",
      "gemi:rl:1.2.3.4:/api/x:59",
      "10",
      "1000",
      "400", // elapsed into the current window
      "1",
    ]);
  });

  test("honours a custom prefix and cost", async () => {
    const client = fakeRedis();
    const limiter = new RedisRateLimiter({ client, prefix: "app" });

    await limiter.consume({ key: "k", limit: 10, window: 1000, cost: 3 });

    const [call] = client.evalshaCalls();
    expect(call.args[2]).toBe("app:k:60");
    expect(call.args.at(-1)).toBe("3");
  });

  test("loads the script once and reuses the digest", async () => {
    const client = fakeRedis();
    const limiter = new RedisRateLimiter({ client });

    await limiter.consume({ key: "k", limit: 10, window: 1000 });
    await limiter.consume({ key: "k", limit: 10, window: 1000 });

    expect(client.loadCalls()).toHaveLength(1);
    expect(client.evalshaCalls()).toHaveLength(2);
  });

  test("turns an allowed reply into remaining budget", async () => {
    // 3 in this window, 10 in the previous one, 400ms in => usage 3 + 6 = 9.
    const client = fakeRedis({ evalsha: [1, 3, 10] });
    const limiter = new RedisRateLimiter({ client });

    const result = await limiter.consume({
      key: "k",
      limit: 20,
      window: 1000,
    });

    expect(result).toEqual({
      allowed: true,
      limit: 20,
      remaining: 11,
      resetAt: 61_000,
      retryAfter: 0,
    });
  });

  test("turns a rejected reply into a retry delay", async () => {
    const client = fakeRedis({ evalsha: [0, 10, 0] });
    const limiter = new RedisRateLimiter({ client });

    const result = await limiter.consume({
      key: "k",
      limit: 10,
      window: 1000,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(700);
  });

  test("reloads the script and retries once after a flush", async () => {
    const client = fakeRedis({
      evalshaQueue: [new Error("NOSCRIPT No matching script"), [1, 1, 0]],
    });
    const limiter = new RedisRateLimiter({ client });

    const result = await limiter.consume({
      key: "k",
      limit: 10,
      window: 1000,
    });

    expect(result.allowed).toBe(true);
    expect(client.loadCalls()).toHaveLength(2);
    expect(client.evalshaCalls()).toHaveLength(2);
  });

  test("gives up after a second NOSCRIPT rather than looping", async () => {
    const onError = vi.fn();
    const client = fakeRedis({
      evalsha: new Error("NOSCRIPT No matching script"),
    });
    const limiter = new RedisRateLimiter({ client, onError });

    await limiter.consume({ key: "k", limit: 10, window: 1000 });

    expect(client.evalshaCalls()).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

const params = { key: "k", limit: 10, window: 1000 };

/** Lets a background `PING` started by a call settle. */
async function afterProbeInterval(ms = 1_000) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("when redis is unreachable", () => {
  test("counts in memory by default, and reports the failure", async () => {
    const onError = vi.fn();
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({ client, onError });

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.consume({ key: "k", limit: 3, window: 1000 }));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[0].remaining).toBe(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("counts in the fallback driver it is given", async () => {
    const fallback = new InMemoryRateLimiter();
    const consume = vi.spyOn(fallback, "consume");
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({ client, fallback, onError: () => {} });

    await limiter.consume({ ...params, cost: 2 });

    expect(consume).toHaveBeenCalledWith({ ...params, cost: 2 });
    expect(fallback.size).toBe(1);
  });

  test('admits uncounted with onRedisError: "open"', async () => {
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({ client, onRedisError: "open", onError: () => {} });

    const result = await limiter.consume({ ...params, cost: 2 });

    expect(result).toEqual({
      allowed: true,
      limit: 10,
      remaining: 8,
      resetAt: 61_000,
      retryAfter: 0,
    });
  });

  test('rejects with onRedisError: "closed"', async () => {
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({ client, onRedisError: "closed", onError: () => {} });

    const result = await limiter.consume(params);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(1000);
  });

  test("still honours the deprecated failOpen", async () => {
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const open = new RedisRateLimiter({ client, failOpen: true, onError: () => {} });
    const closed = new RedisRateLimiter({ client, failOpen: false, onError: () => {} });
    const memory = new RedisRateLimiter({
      client,
      failOpen: false,
      onRedisError: "memory",
      onError: () => {},
    });

    const one = { key: "k", limit: 1, window: 1000 };
    await open.consume(one);
    expect((await open.consume(one)).allowed).toBe(true);
    expect((await closed.consume(one)).allowed).toBe(false);
    expect((await memory.consume(one)).allowed).toBe(true);
    expect((await memory.consume(one)).allowed).toBe(false);
  });

  test("does not cache a failed script load", async () => {
    let attempt = 0;
    const client = fakeRedis({
      load: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection refused");
        return "sha-1";
      },
    });
    const limiter = new RedisRateLimiter({ client, onError: () => {} });

    const first = await limiter.consume(params);
    expect(first.allowed).toBe(true);
    expect(client.evalshaCalls()).toHaveLength(0);

    // Back on Redis once a PING answers; the load is tried again then.
    await afterProbeInterval();
    await limiter.consume(params); // starts the PING
    await vi.advanceTimersByTimeAsync(0);
    await limiter.consume(params);
    expect(client.loadCalls()).toHaveLength(2);
    expect(client.evalshaCalls()).toHaveLength(1);
  });
});

// #1011: once a call fails, the limiter stops sending its script until Redis
// answers a PING, so the increments of an outage are never replayed by Bun's
// offline queue (or a stalled connection) on recovery.
describe("outage and recovery", () => {
  test("stops sending the script after a failure, and answers from memory", async () => {
    const client = fakeRedis({
      evalsha: new Error("connection refused"),
      ping: new Error("connection refused"),
    });
    const limiter = new RedisRateLimiter({ client, onError: () => {} });

    for (let i = 0; i < 20; i++) {
      await limiter.consume(params);
      await vi.advanceTimersByTimeAsync(10);
    }

    // One script call (the one that failed), then only PINGs, one a second.
    expect(client.evalshaCalls()).toHaveLength(1);
    expect(client.pingCalls().length).toBeLessThanOrEqual(1);
  });

  test("goes back to Redis once a PING answers", async () => {
    let up = false;
    const down = () => {
      if (!up) throw new Error("connection refused");
    };
    const client = fakeRedis({
      evalsha: () => (down(), [1, 1, 0]),
      ping: () => (down(), "PONG"),
    });
    const onError = vi.fn();
    const limiter = new RedisRateLimiter({ client, onError });

    await limiter.consume(params);
    await afterProbeInterval();
    await limiter.consume(params); // starts a PING, which fails
    await vi.advanceTimersByTimeAsync(0);
    expect(client.pingCalls()).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(2);

    up = true;
    await limiter.consume(params); // too soon for another PING
    expect(client.pingCalls()).toHaveLength(1);
    await afterProbeInterval();
    await limiter.consume(params); // starts a PING, which answers
    await vi.advanceTimersByTimeAsync(0);
    expect(client.evalshaCalls()).toHaveLength(1);

    await limiter.consume(params);
    expect(client.evalshaCalls()).toHaveLength(2);
  });

  test("does not replay the calls of an outage once Redis is back", async () => {
    // A client that queues what it is sent while disconnected and runs it on
    // reconnect, like Bun's offline queue; and counts like the script.
    let connected = true;
    let counted = 0;
    const queued: (() => void)[] = [];
    const client = {
      get connected() {
        return connected;
      },
      send(command: string, args: string[]) {
        const exec = () => {
          if (command === "SCRIPT") return "sha-1";
          if (command === "PING") return "PONG";
          counted += Number(args.at(-1));
          return [1, counted, 0];
        };
        if (connected) return Promise.resolve(exec());
        return new Promise((resolve) => queued.push(() => resolve(exec())));
      },
    };
    const limiter = new RedisRateLimiter({ client, onError: () => {} });

    await limiter.consume(params);
    expect(counted).toBe(1);

    connected = false;
    for (let i = 0; i < 50; i++) {
      await limiter.consume(params);
      await vi.advanceTimersByTimeAsync(100);
    }

    connected = true;
    for (const run of queued.splice(0)) run();
    await afterProbeInterval();
    await limiter.consume(params); // its PING answers
    await vi.advanceTimersByTimeAsync(0);
    await limiter.consume(params);

    // The call before the outage and the one after it: none of the 50.
    expect(counted).toBe(2);
  });

  test("bounds what a stalled connection replays to the calls sent before the first timeout", async () => {
    // Connected, but nothing answers until `resume()`: then everything that
    // was written runs, like a paused Redis.
    let stalled = false;
    let counted = 0;
    const pending: (() => void)[] = [];
    const client = {
      connected: true,
      send(command: string, _args: string[]) {
        const exec = () => {
          if (command === "SCRIPT") return "sha-1";
          if (command === "PING") return "PONG";
          counted += 1;
          return [1, counted, 0];
        };
        if (!stalled) return Promise.resolve(exec());
        return new Promise((resolve) => pending.push(() => resolve(exec())));
      },
    };
    const limiter = new RedisRateLimiter({ client, timeout: 100, onError: () => {} });
    await limiter.consume(params); // loads the script

    stalled = true;
    const first = limiter.consume(params);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).allowed).toBe(true);
    for (let i = 0; i < 30; i++) {
      await limiter.consume(params);
      await vi.advanceTimersByTimeAsync(100);
    }

    stalled = false;
    for (const run of pending.splice(0)) run();
    await vi.advanceTimersByTimeAsync(0);

    // 1 before the stall, 1 sent into it; the rest were never sent.
    expect(counted).toBe(2);
  });

  test("skips a client that says it is disconnected once it was seen connected", async () => {
    const client = fakeRedis();
    client.connected = true;
    const onError = vi.fn();
    const limiter = new RedisRateLimiter({ client, onError });
    await limiter.consume(params);

    client.connected = false;
    const result = await limiter.consume(params);

    expect(result.allowed).toBe(true);
    expect(client.evalshaCalls()).toHaveLength(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(RedisRateLimiterDisconnectedError);
  });

  test("sends to a new client that is still making its first connection", async () => {
    const client = fakeRedis();
    client.connected = false;
    const limiter = new RedisRateLimiter({ client, onError: () => {} });

    await limiter.consume(params);

    expect(client.evalshaCalls()).toHaveLength(1);
  });

  test("an onError that throws from a background PING is swallowed", async () => {
    const client = fakeRedis({
      evalsha: new Error("connection refused"),
      ping: new Error("connection refused"),
    });
    let calls = 0;
    const limiter = new RedisRateLimiter({
      client,
      onError: () => {
        calls += 1;
        if (calls > 1) throw new Error("boom");
      },
    });

    await limiter.consume(params);
    await afterProbeInterval();
    await limiter.consume(params);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(2);
  });
});

describe("the default error log", () => {
  test("writes at most one line a minute, with what it left out", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      let up = false;
      const client = fakeRedis({
        evalsha: () => (up ? [1, 1, 0] : new Error("connection refused")),
        ping: () => (up ? "PONG" : new Error("connection refused")),
      });
      const limiter = new RedisRateLimiter({ client });

      for (let i = 0; i < 59; i++) {
        await limiter.consume(params);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toMatch(/counting in memory/);

      await vi.advanceTimersByTimeAsync(1_000);
      await limiter.consume(params);
      await vi.advanceTimersByTimeAsync(0);
      expect(error).toHaveBeenCalledTimes(2);
      expect(String(error.mock.calls[1][0])).toMatch(/calls answered without Redis/);

      up = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await limiter.consume(params);
      await vi.advanceTimersByTimeAsync(0);
      expect(info).toHaveBeenCalledOnce();
      expect(String(info.mock.calls[0][0])).toMatch(/answers again/);
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });
});

describe("resolving the app's shared client", () => {
  // This used to go through a hand-forged `{ token: "redis" }` cast, because
  // `RedisManager` could not be imported without dragging Bun's `RedisClient`
  // into the module graph. #403 removed that constraint and the cast with it,
  // so the resolution now depends on `RedisManager` being the same token the
  // provider binds — which is the part worth pinning.
  test("uses the RedisManager bound on the application", async () => {
    const client = fakeRedis();
    const application = new Application();
    application.singleton(RedisManager, () => {
      const manager = new RedisManager();
      manager.client = client as any;
      return manager;
    });

    const limiter = new RedisRateLimiter();
    await kernelContext.run(application, () =>
      limiter.consume({ key: "k", limit: 10, window: 1000 }),
    );

    expect(client.evalshaCalls()).toHaveLength(1);
  });

  test("says what to do when nothing is bound", async () => {
    const limiter = new RedisRateLimiter({ onError: (error) => { throw error; } });

    await expect(
      kernelContext.run(new Application(), () =>
        limiter.consume({ key: "k", limit: 10, window: 1000 }),
      ),
    ).rejects.toThrow(/RedisServiceProvider/);
  });
});

// #982: while Redis is down or stops answering, a command can wait out Bun's
// connect timeout and reconnect loop (10 to 30 s), or forever on an open
// connection that went silent. `timeout` bounds every `consume`.
describe("when redis does not answer", () => {
  const never = () => new Promise(() => {});

  test("gives up after 250 ms by default and counts in memory", async () => {
    const onError = vi.fn();
    const client = fakeRedis({ evalsha: never });
    const limiter = new RedisRateLimiter({ client, onError });

    let settled: any = null;
    const pending = limiter
      .consume({ key: "k", limit: 10, window: 1000 })
      .then((result) => (settled = result));

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled.allowed).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(RedisRateLimiterTimeoutError);
  });

  test("rejects at the timeout with onRedisError: \"closed\"", async () => {
    const client = fakeRedis({ evalsha: never });
    const limiter = new RedisRateLimiter({
      client,
      onRedisError: "closed",
      timeout: 50,
      onError: () => {},
    });

    const pending = limiter.consume({ key: "k", limit: 10, window: 1000 });
    await vi.advanceTimersByTimeAsync(50);

    expect((await pending).allowed).toBe(false);
  });

  test("covers a script load that hangs, and loads again on the next call", async () => {
    let attempt = 0;
    const client = fakeRedis({
      load: () => (++attempt === 1 ? never() : "sha-1"),
    });
    const limiter = new RedisRateLimiter({ client, timeout: 100, onError: () => {} });

    const first = limiter.consume({ key: "k", limit: 10, window: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).allowed).toBe(true);

    // The stuck load is not awaited again: once a PING answers, the next call
    // loads and counts.
    await vi.advanceTimersByTimeAsync(1_000);
    await limiter.consume({ key: "k", limit: 10, window: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await limiter.consume({ key: "k", limit: 10, window: 1000 });
    expect(client.loadCalls()).toHaveLength(2);
    expect(client.evalshaCalls()).toHaveLength(1);
  });

  test("timeout: 0 waits for Redis however long it takes", async () => {
    let answer!: (value: unknown) => void;
    const client = fakeRedis({
      evalsha: () => new Promise((resolve) => (answer = resolve)),
    });
    const limiter = new RedisRateLimiter({ client, timeout: 0, onError: () => {} });

    let settled: any = null;
    const pending = limiter
      .consume({ key: "k", limit: 10, window: 1000 })
      .then((result) => (settled = result));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBeNull();

    answer([0, 10, 0]);
    await pending;
    expect(settled.allowed).toBe(false);
  });

  test("leaves no timer behind once Redis answers", async () => {
    const limiter = new RedisRateLimiter({ client: fakeRedis() });

    await limiter.consume({ key: "k", limit: 10, window: 1000 });

    expect(vi.getTimerCount()).toBe(0);
  });
});
