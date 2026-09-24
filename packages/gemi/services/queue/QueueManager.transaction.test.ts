import { afterEach, describe, expect, test, vi } from "vitest";

import { currentTransaction, withTransaction } from "../../orm/context";
import { Job } from "./Job";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { EnqueueJob } from "./QueueDriver";
import { QueueManager } from "./QueueManager";

/**
 * A dispatch inside an ORM transaction belongs to it (#563): it is recorded
 * when the transaction commits and never if it rolls back.
 *
 * This is the manager's half, over drivers that cannot write into the
 * transaction — the memory driver here, and the database driver on SQLite or
 * on another connection. The half where the driver writes the row on the
 * transaction is the contract's, which runs against real databases.
 *
 * No database is needed for the half tested here: what the manager relies on
 * is `withTransaction`'s commit hook, and it only calls `begin` and
 * `savepoint` on the pool. The fake is the one `orm/context.test.ts` uses.
 */
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

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function recorder() {
  const runs: number[] = [];
  class Record extends Job {
    static name = "Record";
    run(n: number) {
      runs.push(n);
    }
  }
  return { Record, runs };
}

describe("a dispatch inside a transaction, on a driver that does not join it", () => {
  test("is not recorded or run until the commit, and then is, under the id it resolved to", async () => {
    const { Record, runs } = recorder();
    const queue = new QueueManager({ jobs: [Record] });
    const driver = queue.driver as MemoryQueueDriver;
    const enqueue = vi.spyOn(driver, "enqueue");

    let id: string | undefined;
    await withTransaction(fakePool(), async () => {
      // Awaited inside the transaction, which is the case that has to
      // resolve now: a promise waiting for the commit would never return,
      // because the commit waits for this callback.
      id = await queue.push(Record, "[1]");
      await settle();
      expect(enqueue).not.toHaveBeenCalled();
      expect(driver.waiting).toBe(0);
      expect(runs).toEqual([]);
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    await expect(enqueue.mock.results[0]!.value).resolves.toBe(id);
    await settle();
    expect(runs).toEqual([1]);
  });

  test("is dropped when the transaction rolls back", async () => {
    const { Record, runs } = recorder();
    const queue = new QueueManager({ jobs: [Record] });
    const enqueue = vi.spyOn(queue.driver, "enqueue");

    await expect(
      withTransaction(fakePool(), async () => {
        await queue.push(Record, "[1]");
        throw new Error("card declined");
      }),
    ).rejects.toThrow("card declined");

    await settle();
    expect(enqueue).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  test("is dropped with a savepoint that rolls back, and kept with one that commits", async () => {
    const { Record, runs } = recorder();
    const queue = new QueueManager({ jobs: [Record] });
    const pool = fakePool();

    await withTransaction(pool, async () => {
      await withTransaction(pool, () => queue.push(Record, "[1]"));
      await withTransaction(pool, async () => {
        await queue.push(Record, "[2]");
        throw new Error("inner");
      }).catch(() => {});
      await queue.push(Record, "[3]");
    });

    await settle();
    expect(runs).toEqual([1, 3]);
  });

  test("is recorded outside the transaction, not inside it", async () => {
    const { Record } = recorder();
    const queue = new QueueManager({ jobs: [Record] });
    let during: unknown = "not called";
    vi.spyOn(queue.driver, "enqueue").mockImplementation(async () => {
      during = currentTransaction();
      return "id";
    });

    await withTransaction(fakePool(), () => queue.push(Record, "[1]"));

    expect(during).toBeUndefined();
  });

  test("that the driver then cannot record is said on stderr, and the commit stands", async () => {
    const { Record } = recorder();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new QueueManager({ jobs: [Record] });
    vi.spyOn(queue.driver, "enqueue").mockRejectedValue(new Error("pool timeout"));

    // `reportFailure: false` is what `EventManager` passes, meaning "I will
    // catch it". It cannot: the promise it holds resolved inside the
    // transaction. So the queue says it, or nobody does.
    const result = await withTransaction(fakePool(), async () => {
      await queue.push(Record, "[1]", { reportFailure: false });
      return "committed";
    });

    expect(result).toBe("committed");
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("could not record Record"))).toHaveLength(1);
    expect(lines.join("\n")).toContain("held until its transaction committed");
    // Reported once, by the queue, not a second time by the commit hook.
    expect(lines.join("\n")).not.toContain("after-commit callback threw");
  });
});

describe("a dispatch outside a transaction", () => {
  test("is recorded at once, under an id the driver chooses", async () => {
    const { Record, runs } = recorder();
    const queue = new QueueManager({ jobs: [Record] });
    const enqueue = vi.spyOn(queue.driver, "enqueue");

    const id = await queue.push(Record, "[1]");

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).not.toHaveProperty("id");
    await settle();
    expect(runs).toEqual([1]);
    expect(typeof id).toBe("string");
  });
});

describe("a dispatch inside a transaction, on a driver that joins it", () => {
  /**
   * The memory driver, claiming to write into the transaction. It does not
   * really, so a claim could see the job early; what is under test is only
   * what the manager does with the answer.
   */
  function joining() {
    const driver = new MemoryQueueDriver();
    const calls: Array<{ job: EnqueueJob; inTransaction: boolean }> = [];
    const enqueue = driver.enqueue.bind(driver);
    Object.assign(driver, {
      joinsTransaction: () => currentTransaction() !== undefined,
      enqueue: (job: EnqueueJob) => {
        calls.push({ job, inTransaction: currentTransaction() !== undefined });
        return enqueue(job);
      },
    });
    return { driver, calls };
  }

  test("is handed to the driver at once, inside the transaction, under the driver's id", async () => {
    const { Record } = recorder();
    const { driver, calls } = joining();
    const queue = new QueueManager({ jobs: [Record], driver });

    await withTransaction(fakePool(), async () => {
      await queue.push(Record, "[1]");
      expect(calls).toHaveLength(1);
    });

    expect(calls[0]!.inTransaction).toBe(true);
    expect(calls[0]!.job).not.toHaveProperty("id");
  });

  test("does not wake a polled queue until the commit", async () => {
    const { Record, runs } = recorder();
    const { driver } = joining();
    // Polled, so a dispatch is only claimed early if something wakes the loop.
    Object.assign(driver, { subscribe: undefined });
    const queue = new QueueManager({ jobs: [Record], driver, pollInterval: 60_000 });
    queue.start();
    await settle();

    await withTransaction(fakePool(), async () => {
      await queue.push(Record, "[1]");
      await settle();
      // Woken here, the loop would claim before the commit — with a real
      // joining driver it would find nothing, and then sleep a minute.
      expect(runs).toEqual([]);
    });

    await settle();
    expect(runs).toEqual([1]);
    await queue.stop();
  });
});
