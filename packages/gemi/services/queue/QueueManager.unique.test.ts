import { afterEach, describe, expect, test, vi } from "vitest";

import { withTransaction } from "../../orm/context";
import { MemoryLockStore } from "../lock/MemoryLockStore";
import { Job } from "./Job";
import type { MemoryQueueDriver } from "./MemoryQueueDriver";
import { QueueManager } from "./QueueManager";

/**
 * Unique jobs (#662) on the memory driver. The cross-instance half, several
 * managers over one database, is in `services/lock/DatabaseLockStore.test.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake pool `QueueManager.transaction.test.ts` uses. */
function fakePool() {
  const handle: any = {
    savepoint(fn: (sp: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  };
  return {
    begin(fn: (tx: any) => Promise<unknown>) {
      return Promise.resolve().then(() => fn(handle));
    },
  } as any;
}

function uniqueJob(runs: string[], options: { fail?: boolean } = {}) {
  return class Rebuild extends Job {
    static name = "Rebuild";
    maxAttempts = 1;
    uniqueId(reportId: string) {
      return reportId === "none" ? undefined : `report:${reportId}`;
    }
    async run(reportId: string) {
      runs.push(reportId);
      if (options.fail) throw new Error("failed");
    }
  };
}

describe("unique jobs", () => {
  test("a dispatch while one with the key is queued resolves to that job's id", async () => {
    const runs: string[] = [];
    const Rebuild = uniqueJob(runs);
    const queue = new QueueManager({ jobs: [Rebuild] });
    await queue.stop();
    const driver = queue.driver as MemoryQueueDriver;

    const first = await queue.push(Rebuild, '["a"]');
    expect(await queue.push(Rebuild, '["a"]')).toBe(first);
    expect(await queue.push(Rebuild, '["b"]')).not.toBe(first);
    expect(driver.waiting).toBe(2);
  });

  test("a job whose uniqueId returns nothing is not unique", async () => {
    const queue = new QueueManager({ jobs: [uniqueJob([])] });
    await queue.stop();
    const Rebuild = queue.jobs.Rebuild!;
    const a = await queue.push(Rebuild, '["none"]');
    const b = await queue.push(Rebuild, '["none"]');
    expect(a).not.toBe(b);
  });

  test("the key frees when the job completes or is dead-lettered", async () => {
    for (const fail of [false, true]) {
      const runs: string[] = [];
      const Rebuild = uniqueJob(runs, { fail });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const queue = new QueueManager({ jobs: [Rebuild], locks: new MemoryLockStore() });
      const first = await queue.push(Rebuild, '["a"]');
      await settle();
      expect(runs).toEqual(["a"]);
      expect(await queue.locks.store.holder("gemi:job:Rebuild:report:a")).toBeNull();
      expect(await queue.push(Rebuild, '["a"]')).not.toBe(first);
      await settle();
      expect(runs).toEqual(["a", "a"]);
    }
  });

  test("a job that is not unique never touches the lock store", async () => {
    class Plain extends Job {
      static name = "Plain";
    }
    const store = new MemoryLockStore();
    const acquire = vi.spyOn(store, "acquire");
    const queue = new QueueManager({ jobs: [Plain], locks: store });
    await queue.push(Plain, "[]");
    await settle();
    expect(acquire).not.toHaveBeenCalled();
  });

  test("inside a transaction it waits for the commit, and is dropped on rollback", async () => {
    const runs: string[] = [];
    const Rebuild = uniqueJob(runs);
    const queue = new QueueManager({ jobs: [Rebuild] });
    await queue.stop();
    const driver = queue.driver as MemoryQueueDriver;

    await expect(
      withTransaction(fakePool(), async () => {
        await queue.push(Rebuild, '["a"]');
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    // Nothing queued, and the key was never taken.
    expect(driver.waiting).toBe(0);
    expect(await queue.locks.store.holder("gemi:job:Rebuild:report:a")).toBeNull();

    let held: string | undefined;
    await withTransaction(fakePool(), async () => {
      held = await queue.push(Rebuild, '["a"]');
      expect(driver.waiting).toBe(0);
    });
    await settle();
    expect(driver.waiting).toBe(1);
    expect(await queue.push(Rebuild, '["a"]')).toBe(held);
  });

  test("a uniqueId that throws throws from the dispatch", () => {
    class Broken extends Job {
      static name = "Broken";
      uniqueId(): string {
        throw new Error("no key");
      }
    }
    const queue = new QueueManager({ jobs: [Broken] });
    expect(() => queue.push(Broken, "[]")).toThrow("no key");
  });
});

describe("the queue's lock store", () => {
  test("is the memory store for the memory driver, built once", () => {
    const queue = new QueueManager();
    expect(queue.locks.store).toBeInstanceOf(MemoryLockStore);
    expect(queue.locks).toBe(queue.locks);
  });

  test("warns when a durable driver keeps no locks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = {
      enqueue: async () => "id",
      claim: async () => [],
      complete: async () => {},
      fail: async () => {},
      release: async () => {},
    };
    const queue = new QueueManager({ driver });
    expect(queue.locks.store).toBeInstanceOf(MemoryLockStore);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("only hold within this process"));
  });

  test("refuses an unknown setting", () => {
    const queue = new QueueManager({ locks: "redis" as never });
    expect(() => queue.locks).toThrow('Unknown queue locks "redis"');
  });
});
