import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PREFETCH_TTL, PrefetchCache } from "./PrefetchCache";

const START = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("prime", () => {
  test("loads once while an entry is fresh", async () => {
    const cache = new PrefetchCache();
    const load = vi.fn(async () => ({ ok: true }));

    await cache.prime("/a.json", load);
    await cache.prime("/a.json", load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  test("shares the in-flight request with a second caller", async () => {
    const cache = new PrefetchCache();
    const load = vi.fn(() => Promise.resolve({ ok: true }));

    const [first, second] = await Promise.all([
      cache.prime("/a.json", load),
      cache.prime("/a.json", load),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  test("loads again once the entry has expired", async () => {
    const cache = new PrefetchCache();
    const load = vi.fn(async () => ({ ok: true }));

    await cache.prime("/a.json", load);
    vi.setSystemTime(START + PREFETCH_TTL);
    await cache.prime("/a.json", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  test("keeps targets apart", async () => {
    const cache = new PrefetchCache();
    const load = vi.fn(async () => ({ ok: true }));

    await cache.prime("/a.json", load);
    await cache.prime("/b.json", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("take", () => {
  test("hands over the prefetched payload", async () => {
    const cache = new PrefetchCache();
    const payload = { data: {} };
    await cache.prime("/a.json", async () => payload);

    await expect(cache.take("/a.json")).resolves.toBe(payload);
  });

  test("misses when nothing was prefetched", () => {
    expect(new PrefetchCache().take("/a.json")).toBeNull();
  });

  test("hands the payload over only once", async () => {
    const cache = new PrefetchCache();
    await cache.prime("/a.json", async () => ({ data: {} }));

    await cache.take("/a.json");

    expect(cache.take("/a.json")).toBeNull();
  });

  test("misses on an expired entry", async () => {
    const cache = new PrefetchCache();
    await cache.prime("/a.json", async () => ({ data: {} }));

    vi.setSystemTime(START + PREFETCH_TTL);

    expect(cache.take("/a.json")).toBeNull();
  });
});

describe("failed prefetches", () => {
  test("resolve to null rather than rejecting", async () => {
    const cache = new PrefetchCache();

    await expect(
      cache.prime("/a.json", async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeNull();
  });

  test("are not handed to a navigation", async () => {
    const cache = new PrefetchCache();
    await cache.prime("/a.json", async () => null);

    expect(cache.take("/a.json")).toBeNull();
  });

  test("are retried on the next attempt", async () => {
    const cache = new PrefetchCache();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: {} });

    await cache.prime("/a.json", load);
    await cache.prime("/a.json", load);

    expect(load).toHaveBeenCalledTimes(2);
    await expect(cache.take("/a.json")).resolves.toEqual({ data: {} });
  });
});
