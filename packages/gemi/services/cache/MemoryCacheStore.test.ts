import { describe, expect, test } from "vitest";

import { MemoryCacheStore } from "./MemoryCacheStore";

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MemoryCacheStore", () => {
  test("stores, reads and deletes", async () => {
    const store = new MemoryCacheStore();
    expect(await store.get("a")).toBeNull();
    await store.set("a", "1", null);
    expect(await store.get("a")).toBe("1");
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(await store.get("a")).toBeNull();
  });

  test("expires an entry at its ttl, on its own clock", async () => {
    const time = clock();
    const store = new MemoryCacheStore({ now: time.now });
    await store.set("a", "1", 100);
    time.advance(99);
    expect(await store.get("a")).toBe("1");
    time.advance(1);
    expect(await store.get("a")).toBeNull();
    expect(store.size).toBe(0);
  });

  test("delete of an expired entry reports nothing was there", async () => {
    const time = clock();
    const store = new MemoryCacheStore({ now: time.now });
    await store.set("a", "1", 10);
    time.advance(10);
    expect(await store.delete("a")).toBe(false);
  });

  test("evicts the least recently used entry past maxEntries", async () => {
    const store = new MemoryCacheStore({ maxEntries: 2 });
    await store.set("a", "1", null);
    await store.set("b", "2", null);
    // Reading `a` makes `b` the least recently used.
    await store.get("a");
    await store.set("c", "3", null);
    expect(await store.get("b")).toBeNull();
    expect(await store.get("a")).toBe("1");
    expect(await store.get("c")).toBe("3");
  });

  test("overwriting a key replaces its value and its ttl", async () => {
    const time = clock();
    const store = new MemoryCacheStore({ now: time.now });
    await store.set("a", "1", 10);
    await store.set("a", "2", null);
    time.advance(1_000);
    expect(await store.get("a")).toBe("2");
    expect(store.size).toBe(1);
  });

  test("flush empties it", async () => {
    const store = new MemoryCacheStore();
    await store.set("a", "1", null);
    await store.flush();
    expect(store.size).toBe(0);
  });

  test("refuses a maxEntries that cannot hold anything", () => {
    expect(() => new MemoryCacheStore({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new MemoryCacheStore({ maxEntries: 1.5 })).toThrow(/maxEntries/);
  });
});
