import { describe, expect, test } from "vitest";

import { RedisCacheStore, type CacheRedisClient } from "./RedisCacheStore";

/** Enough of Redis for the store: strings with PX expiry, DEL, SCAN, UNLINK. */
function fakeRedis(pageSize = 2) {
  const data = new Map<string, string>();
  const calls: [string, string[]][] = [];
  // Real SCAN visits every key present for the whole iteration, even when
  // some are deleted between pages; a snapshot taken at cursor 0 does that.
  let scanning: string[] = [];
  const client: CacheRedisClient = {
    async send(command, args) {
      calls.push([command, args]);
      switch (command) {
        case "GET":
          return data.get(args[0]!) ?? null;
        case "SET":
          data.set(args[0]!, args[1]!);
          return "OK";
        case "DEL":
        case "UNLINK":
          return args.filter((key) => data.delete(key)).length;
        case "SCAN": {
          const cursor = Number(args[0]);
          const pattern = args[2]!;
          const prefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
          if (cursor === 0) scanning = [...data.keys()].filter((key) => key.startsWith(prefix));
          const keys = scanning;
          const page = keys.slice(cursor, cursor + pageSize);
          const next = cursor + pageSize >= keys.length ? 0 : cursor + pageSize;
          return [String(next), page];
        }
        default:
          throw new Error(`unexpected ${command}`);
      }
    },
  };
  return { client, data, calls };
}

describe("RedisCacheStore", () => {
  test("prefixes keys and sets PX for a ttl", async () => {
    const redis = fakeRedis();
    const store = new RedisCacheStore({ client: redis.client, prefix: "app:" });
    await store.set("a", "1", 1500);
    await store.set("b", "2", null);
    expect(redis.calls).toEqual([
      ["SET", ["app:a", "1", "PX", "1500"]],
      ["SET", ["app:b", "2"]],
    ]);
    expect(await store.get("a")).toBe("1");
    expect(await store.get("missing")).toBeNull();
  });

  test("defaults the prefix to gemi:cache:", async () => {
    const redis = fakeRedis();
    await new RedisCacheStore({ client: redis.client }).set("a", "1", null);
    expect([...redis.data.keys()]).toEqual(["gemi:cache:a"]);
  });

  test("delete reports whether a key was removed", async () => {
    const redis = fakeRedis();
    const store = new RedisCacheStore({ client: redis.client });
    await store.set("a", "1", null);
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
  });

  test("flush removes only its own prefix, across SCAN pages", async () => {
    const redis = fakeRedis(2);
    const store = new RedisCacheStore({ client: redis.client, prefix: "app[1]:" });
    for (const key of ["a", "b", "c", "d", "e"]) await store.set(key, "x", null);
    redis.data.set("other:a", "keep");

    await store.flush();

    expect([...redis.data.keys()]).toEqual(["other:a"]);
    // The glob characters in the prefix are escaped, so it matches only itself.
    expect(redis.calls.find(([command]) => command === "SCAN")?.[1][2]).toBe("app\\[1\\]:*");
  });

  test("refuses to flush the whole database", async () => {
    const store = new RedisCacheStore({ client: fakeRedis().client, prefix: "" });
    await expect(store.flush()).rejects.toThrow(/empty prefix/);
  });

  test("lets a Redis error through", async () => {
    const store = new RedisCacheStore({
      client: { send: async () => Promise.reject(new Error("ECONNREFUSED")) },
    });
    await expect(store.delete("a")).rejects.toThrow("ECONNREFUSED");
  });
});
