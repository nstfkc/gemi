import { afterEach, describe, expect, test, vi } from "vitest";

import { LockManager } from "./LockManager";
import { LockLostError } from "./LockStore";
import { MemoryLockStore } from "./MemoryLockStore";
import { lockStoreContract } from "./lockStoreContract";

lockStoreContract("MemoryLockStore", async () => {
  const store = new MemoryLockStore();
  return { store: () => store, dispose: async () => {} };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LockManager", () => {
  test("run holds the lock for its callback and releases it after", async () => {
    const locks = new LockManager(new MemoryLockStore());
    let inner: unknown;
    const result = await locks.run("snapshot", { ttl: 1_000 }, async (lock) => {
      expect(lock.token).toBe(1);
      inner = await locks.run("snapshot", {}, () => "second");
      return "first";
    });
    expect(result).toEqual({ acquired: true, value: "first" });
    expect(inner).toEqual({ acquired: false });
    expect(await locks.run("snapshot", {}, () => "again")).toEqual({
      acquired: true,
      value: "again",
    });
  });

  test("run releases the lock when the callback throws", async () => {
    const locks = new LockManager(new MemoryLockStore());
    await expect(
      locks.run("x", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await locks.store.holder("x")).toBeNull();
  });

  test("run renews the lease while the callback outlasts it", async () => {
    const store = new MemoryLockStore();
    const locks = new LockManager(store);
    const result = await locks.run("long", { ttl: 150 }, async (lock) => {
      await sleep(400);
      expect(lock.lost.aborted).toBe(false);
      expect(await locks.acquire("long")).toBeNull();
      return "done";
    });
    expect(result).toEqual({ acquired: true, value: "done" });
  });

  test("a lost lease aborts `lost`, and run rejects instead of completing", async () => {
    const store = new MemoryLockStore();
    const locks = new LockManager(store);
    let thief: number | null = null;
    let aborted: unknown;
    const run = locks.run("stale", { ttl: 150, renew: false }, async (lock) => {
      lock.lost.addEventListener("abort", () => (aborted = lock.lost.reason));
      await sleep(300);
      // Someone else took it after the lease ran out.
      thief = await store.acquire("stale", "thief", 60_000);
      // A fenced write from the stale holder is refused.
      await expect(lock.fence(async () => "late write")).rejects.toBeInstanceOf(LockLostError);
      return "stale result";
    });
    await expect(run).rejects.toBeInstanceOf(LockLostError);
    expect(aborted).toBeInstanceOf(LockLostError);
    expect(thief).toBe(2);
    // The stale holder's release did not free the thief's hold.
    expect(await store.holder("stale")).toEqual({ owner: "thief", token: 2 });
  });

  test("a renewal that finds another holder marks the lock lost", async () => {
    const store = new MemoryLockStore();
    const locks = new LockManager(store);
    const lock = (await locks.acquire("k", { ttl: 1_000 }))!;
    vi.spyOn(store, "extend").mockResolvedValue(false);
    expect(await lock.extend()).toBe(false);
    expect(lock.lost.aborted).toBe(true);
    expect(await lock.release()).toBe(false);
  });

  test("acquire waits for the lock when asked to", async () => {
    const locks = new LockManager(new MemoryLockStore());
    const first = (await locks.acquire("w", { ttl: 10_000 }))!;
    setTimeout(() => void first.release(), 150);
    expect(await locks.acquire("w", { wait: 20 })).toBeNull();
    const second = await locks.acquire("w", { wait: 2_000 });
    expect(second?.token).toBe(2);
    await second!.release();
  });

  test("refuses a ttl that is not positive", async () => {
    const locks = new LockManager(new MemoryLockStore());
    await expect(locks.acquire("t", { ttl: 0 })).rejects.toThrow("ttl");
  });
});
