import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RedisRateLimiter } from "./RedisRateLimiterDriver";

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
    evalshaCalls: () => calls.filter((call) => call.command === "EVALSHA"),
    loadCalls: () => calls.filter((call) => call.command === "SCRIPT"),
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

describe("when redis is unreachable", () => {
  test("admits the request and reports the failure by default", async () => {
    const onError = vi.fn();
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({ client, onError });

    const result = await limiter.consume({
      key: "k",
      limit: 10,
      window: 1000,
      cost: 2,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(8);
    expect(result.resetAt).toBe(61_000);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("rejects instead when failOpen is off", async () => {
    const client = fakeRedis({ evalsha: new Error("connection refused") });
    const limiter = new RedisRateLimiter({
      client,
      failOpen: false,
      onError: () => {},
    });

    const result = await limiter.consume({
      key: "k",
      limit: 10,
      window: 1000,
    });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(1000);
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

    const first = await limiter.consume({ key: "k", limit: 10, window: 1000 });
    const second = await limiter.consume({ key: "k", limit: 10, window: 1000 });

    // The first call failed open; the second must be able to load and count.
    expect(first.allowed).toBe(true);
    expect(client.evalshaCalls()).toHaveLength(1);
    expect(second.allowed).toBe(true);
  });
});
