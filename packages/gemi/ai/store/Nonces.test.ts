import { describe, expect, test } from "vitest";
import { MemoryNonceStore, type NonceRedisClient, RedisNonceStore } from "./Nonces";

/**
 * A Redis stand-in that implements `SET key value PX ms NX` the way Redis
 * does, but yields to the event loop between receiving a command and applying
 * it, so that concurrent callers really do interleave. The apply step itself
 * is synchronous, as Redis's single thread makes it.
 */
function fakeRedis(clock: () => number = Date.now) {
  const keys = new Map<string, number>();
  const commands: string[][] = [];
  const client: NonceRedisClient = {
    async send(command, args) {
      commands.push([command, ...args]);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      if (command !== "SET") throw new Error(`unexpected command ${command}`);
      const [key, , px, ms, nx] = args;
      expect(px).toBe("PX");
      expect(nx).toBe("NX");
      const now = clock();
      const until = keys.get(key);
      if (until !== undefined && until > now) return null;
      keys.set(key, now + Number(ms));
      return "OK";
    },
  };
  return { client, keys, commands };
}

describe("MemoryNonceStore", () => {
  test("spends a nonce once", async () => {
    const store = new MemoryNonceStore();
    const expiresAt = Date.now() + 60_000;
    expect(await store.consume("n1", expiresAt)).toBe(true);
    expect(await store.consume("n1", expiresAt)).toBe(false);
    expect(await store.consume("n2", expiresAt)).toBe(true);
  });

  test("concurrent spends of one nonce: exactly one wins", async () => {
    const store = new MemoryNonceStore();
    const expiresAt = Date.now() + 60_000;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.consume("same", expiresAt)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("forgets a nonce once its token has expired, and sweeps expired entries", () => {
    const store = new MemoryNonceStore();
    const now = 1_000_000;
    expect(store.consumeSync("n", now + 1000, now)).toBe(true);
    expect(store.consumeSync("n", now + 1000, now + 500)).toBe(false);
    expect(store.consumeSync("n", now + 1000, now + 2000)).toBe(true);

    for (let i = 0; store.size < 1024; i++) store.consumeSync(`old-${i}`, now + 10, now);
    // The insert that crosses the threshold sweeps everything already expired.
    store.consumeSync("fresh", now + 60_000, now + 100);
    expect(store.size).toBe(2);
  });
});

describe("RedisNonceStore", () => {
  test("is SET NX with the token's remaining lifetime as PX", async () => {
    const redis = fakeRedis();
    const store = new RedisNonceStore({ client: redis.client, prefix: "t" });
    const expiresAt = Date.now() + 60_000;
    expect(await store.consume("abc", expiresAt)).toBe(true);
    expect(await store.consume("abc", expiresAt)).toBe(false);

    const [command, key, value, px, ms, nx] = redis.commands[0];
    expect([command, key, value, px, nx]).toEqual(["SET", "t:abc", "1", "PX", "NX"]);
    expect(Number(ms)).toBeGreaterThan(59_000);
    expect(Number(ms)).toBeLessThanOrEqual(60_000);
  });

  test("never sends PX 0 for a token at or past its expiry", async () => {
    const redis = fakeRedis();
    const store = new RedisNonceStore({ client: redis.client });
    await store.consume("late", Date.now() - 10);
    expect(Number(redis.commands[0][4])).toBe(1);
  });

  test("two instances sharing Redis, spending concurrently: exactly one wins", async () => {
    const redis = fakeRedis();
    // Separate store objects stand in for separate processes; Redis is the
    // only thing they share.
    const instances = Array.from({ length: 8 }, () => new RedisNonceStore({ client: redis.client }));
    const expiresAt = Date.now() + 60_000;
    const results = await Promise.all(
      instances.flatMap((store) => [store.consume("n", expiresAt), store.consume("n", expiresAt)]),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("a Redis failure rejects rather than reporting the nonce as fresh", async () => {
    const store = new RedisNonceStore({
      client: {
        async send() {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    await expect(store.consume("n", Date.now() + 1000)).rejects.toThrow("ECONNREFUSED");
  });

  test("without a client or a booted app, says how to give it one", async () => {
    const store = new RedisNonceStore();
    await expect(store.consume("n", Date.now() + 1000)).rejects.toThrow();
  });
});
