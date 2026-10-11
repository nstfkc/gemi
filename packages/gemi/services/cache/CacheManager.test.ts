import { describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { Repository } from "../../support/Repository";
import { RedisManager } from "../redis/RedisManager";
import { CacheManager } from "./CacheManager";
import type { CacheStore } from "./CacheStore";
import { MemoryCacheStore } from "./MemoryCacheStore";
import { RedisCacheStore } from "./RedisCacheStore";

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

function cache(options: { ttl?: string | number | null } = {}) {
  const time = clock();
  const store = new MemoryCacheStore({ now: time.now });
  return { time, store, cache: new CacheManager({ store, ttl: options.ttl }) };
}

describe("CacheManager", () => {
  test("round-trips values through JSON, on the memory store too", async () => {
    const { cache: c } = cache();
    const value = { at: new Date(0), list: [1, 2], nested: { ok: true } };
    await c.set("a", value);
    const read = await c.get<any>("a");
    expect(read).toEqual({ at: "1970-01-01T00:00:00.000Z", list: [1, 2], nested: { ok: true } });
    // A copy: changing what came back does not change what is cached.
    read.list.push(3);
    expect((await c.get<any>("a")).list).toEqual([1, 2]);
  });

  test("a miss is undefined; a stored null is a hit", async () => {
    const { cache: c } = cache();
    expect(await c.get("a")).toBeUndefined();
    expect(await c.has("a")).toBe(false);
    await c.set("a", null);
    expect(await c.get("a")).toBeNull();
    expect(await c.has("a")).toBe(true);
  });

  test("refuses undefined and values with no JSON form", async () => {
    const { cache: c } = cache();
    await expect(c.set("a", undefined)).rejects.toThrow(/undefined/);
    await expect(c.set("a", () => 1)).rejects.toThrow(/no JSON form/);
  });

  test("ttl: a Duration per call, the slice's default otherwise, null for none", async () => {
    const { cache: c, time } = cache({ ttl: "1m" });
    await c.set("call", 1, "10s");
    await c.set("default", 1);
    await c.set("forever", 1, null);
    time.advance(10_000);
    expect(await c.has("call")).toBe(false);
    expect(await c.has("default")).toBe(true);
    time.advance(50_000);
    expect(await c.has("default")).toBe(false);
    time.advance(10 ** 9);
    expect(await c.has("forever")).toBe(true);
  });

  test("a ttl of 0 removes the key instead of storing it", async () => {
    const { cache: c } = cache();
    await c.set("a", 1);
    await c.set("a", 2, 0);
    expect(await c.has("a")).toBe(false);
  });

  test("a malformed ttl fails where it was written", async () => {
    const { cache: c } = cache();
    await expect(c.set("a", 1, "soon" as any)).rejects.toThrow(/not a duration/);
    expect(() => new CacheManager({ ttl: "soon" as any })).toThrow(/not a duration/);
  });

  test("delete and pull", async () => {
    const { cache: c } = cache();
    await c.set("a", 1);
    expect(await c.pull("a")).toBe(1);
    expect(await c.pull("a")).toBeUndefined();
    await c.set("b", 1);
    expect(await c.delete("b")).toBe(true);
    expect(await c.delete("b")).toBe(false);
  });

  test("remember computes on a miss, stores, and serves the hit after", async () => {
    const { cache: c, time } = cache();
    const compute = vi.fn(async () => ({ n: 1 }));
    expect(await c.remember("a", "1m", compute)).toEqual({ n: 1 });
    expect(await c.remember("a", "1m", compute)).toEqual({ n: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    time.advance(60_000);
    await c.remember("a", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test("remember shares one compute between concurrent misses", async () => {
    const { cache: c } = cache();
    let release!: (value: string) => void;
    const compute = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const calls = [c.remember("a", compute), c.remember("a", compute), c.remember("a", compute)];
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    release("v");
    expect(await Promise.all(calls)).toEqual(["v", "v", "v"]);
    expect(await c.get("a")).toBe("v");
  });

  test("remember: a throwing compute stores nothing and the next call retries", async () => {
    const { cache: c } = cache();
    await expect(c.remember("a", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await c.has("a")).toBe(false);
    expect(await c.remember("a", () => "ok")).toBe("ok");
  });

  test("remember: undefined is returned and not stored", async () => {
    const { cache: c } = cache();
    expect(await c.remember("a", () => undefined)).toBeUndefined();
    expect(await c.has("a")).toBe(false);
  });

  test("an entry the manager did not write reads as a miss", async () => {
    const { cache: c, store } = cache();
    await store.set("k:a", "{not json", null);
    expect(await c.get("a")).toBeUndefined();
  });

  test("application keys cannot reach tag versions", async () => {
    const { cache: c, store } = cache();
    await c.tags("t").set("a", 1);
    await c.set("tag:t", "x");
    expect(await c.tags("t").get("a")).toBe(1);
    expect(await store.get("tag:t")).not.toBe('"x"');
  });

  test("refuses an empty key", async () => {
    const { cache: c } = cache();
    await expect(c.get("")).rejects.toThrow(/non-empty/);
  });

  test("flush empties the store", async () => {
    const { cache: c } = cache();
    await c.set("a", 1);
    await c.tags("t").set("b", 1);
    await c.flush();
    expect(await c.has("a")).toBe(false);
    expect(await c.tags("t").has("b")).toBe(false);
  });
});

describe("CacheManager tags", () => {
  test("flushing a tag drops every value written under it, and nothing else", async () => {
    const { cache: c } = cache();
    await c.tags("user:1").set("profile", "p1");
    await c.tags("user:1", "team:9").set("role", "admin");
    await c.tags("user:2").set("profile", "p2");
    await c.set("profile", "plain");

    await c.tags("user:1").flush();

    expect(await c.tags("user:1").get("profile")).toBeUndefined();
    expect(await c.tags("user:1", "team:9").get("role")).toBeUndefined();
    expect(await c.tags("user:2").get("profile")).toBe("p2");
    expect(await c.get("profile")).toBe("plain");
  });

  test("tag order and duplicates do not matter; the key alone does not reach a tagged value", async () => {
    const { cache: c } = cache();
    await c.tags("a", "b").set("k", 1);
    expect(await c.tags(["b", "a", "a"]).get("k")).toBe(1);
    expect(await c.get("k")).toBeUndefined();
    expect(await c.tags("a").get("k")).toBeUndefined();
  });

  test("tagged remember, delete and pull", async () => {
    const { cache: c } = cache();
    const tagged = c.tags("t");
    expect(await tagged.remember("k", "1m", () => 1)).toBe(1);
    expect(await tagged.remember("k", "1m", () => 2)).toBe(1);
    expect(await tagged.pull("k")).toBe(1);
    await tagged.set("k", 3);
    expect(await tagged.delete("k")).toBe(true);
  });

  test("a lost tag version only ever causes misses", async () => {
    const { cache: c, store } = cache();
    await c.tags("t").set("k", 1);
    await store.delete("tag:t");
    expect(await c.tags("t").get("k")).toBeUndefined();
  });

  test("a flush on one instance is seen by another sharing the store", async () => {
    const store = new MemoryCacheStore();
    const one = new CacheManager({ store });
    const two = new CacheManager({ store });
    await one.tags("t").set("k", 1);
    expect(await two.tags("t").get("k")).toBe(1);
    await two.tags("t").flush();
    expect(await one.tags("t").get("k")).toBeUndefined();
  });

  test("refuses no tags and empty tags", () => {
    const { cache: c } = cache();
    expect(() => c.tags()).toThrow(/at least one/);
    expect(() => c.tags("")).toThrow(/non-empty/);
  });
});

describe("CacheManager stores", () => {
  test("defaults to a memory store with the configured maxEntries", async () => {
    const c = new CacheManager({ memory: { maxEntries: 1 } });
    expect(c.store).toBeInstanceOf(MemoryCacheStore);
    await c.set("a", 1);
    await c.set("b", 1);
    expect(await c.has("a")).toBe(false);
  });

  test('"redis" uses the application\'s Redis client, built on first command', async () => {
    const sent: [string, string[]][] = [];
    const application = new Application(new Repository({}));
    const manager = new RedisManager();
    manager.client = { send: async (command: string, args: string[]) => (sent.push([command, args]), null) } as any;
    application.instance(RedisManager, manager);

    const c = new CacheManager({ store: "redis", redis: { prefix: "app:" } }, { application });
    expect(c.store).toBeInstanceOf(RedisCacheStore);
    expect(await c.get("a")).toBeUndefined();
    expect(sent).toEqual([["GET", ["app:k:a"]]]);
  });

  test("a store instance or a factory", async () => {
    const store: CacheStore = new MemoryCacheStore();
    expect(new CacheManager({ store }).store).toBe(store);

    const application = new Application(new Repository({}));
    const factory = vi.fn(() => store);
    const c = new CacheManager({ store: factory }, { application });
    expect(c.store).toBe(store);
    expect(c.store).toBe(store);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(application);
  });

  test("an unknown store name says where it came from", () => {
    expect(() => new CacheManager({ store: "memcached" as any }).store).toThrow(
      /Unknown cache store "memcached" in app\/config\/cache.ts/,
    );
  });
});
