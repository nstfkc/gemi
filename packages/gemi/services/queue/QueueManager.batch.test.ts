import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { withTransaction } from "../../orm/context";
import { Repository } from "../../support/Repository";
import type { BatchStatus } from "./batch";
import { Job } from "./Job";
import type { QueueDriver } from "./QueueDriver";
import { QueueManager } from "./QueueManager";
import { QueueServiceProvider } from "./QueueServiceProvider";

/**
 * `Job.dispatchBatch` end to end on the memory driver: the manager's half.
 * What the drivers promise — the counters, exactly-once callbacks, cancel —
 * is the contract's (`queueDriverContract.ts`), run against every driver and
 * database; the database driver's runs across processes are in
 * `DatabaseQueueDriver.test.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(5);
  }
}

/** A booted application whose queue has `jobs`, and a runner for code inside it. */
async function booted(jobs: Array<new () => Job>, queue: Record<string, unknown> = {}) {
  const application = new Application(new Repository({ queue: { jobs, ...queue } }));
  application.registerMany([QueueServiceProvider]);
  await application.boot();
  const inApp = <T>(fn: () => T) => kernelContext.run(application, fn);
  return { application, queue: application.make(QueueManager), inApp };
}

function fixtures() {
  const built: string[] = [];
  const finished: Array<{ label: string; status: BatchStatus }> = [];

  class BuildPage extends Job {
    static name = "BuildPage";
    maxAttempts = 1;
    async run(page: string, importId: string) {
      if (page.startsWith("bad")) throw new Error(`cannot build ${page}`);
      built.push(`${importId}:${page}`);
    }
  }

  class ImportFinished extends Job {
    static name = "ImportFinished";
    run(label: string, status: BatchStatus) {
      finished.push({ label, status });
    }
  }

  return { BuildPage, ImportFinished, built, finished };
}

describe("Job.dispatchBatch", () => {
  test("runs every job, then the callbacks with the batch's status last", async () => {
    const { BuildPage, ImportFinished, built, finished } = fixtures();
    const { inApp } = await booted([BuildPage, ImportFinished]);

    const batch = await inApp(() =>
      BuildPage.dispatchBatch(
        ["a", "b", "c"].map((page) => [page, "imp-1"] as const),
        {
          name: "import:imp-1",
          then: ImportFinished.with("then"),
          catch: ImportFinished.with("catch"),
          finally: ImportFinished.with("finally"),
        },
      ),
    );

    expect(batch).toEqual({ id: expect.any(String), total: 3 });
    await until(() => finished.length === 2);
    expect(built.sort()).toEqual(["imp-1:a", "imp-1:b", "imp-1:c"]);
    expect(finished.map((call) => call.label).sort()).toEqual(["finally", "then"]);
    expect(finished[0]!.status).toMatchObject({
      id: batch.id,
      name: "import:imp-1",
      total: 3,
      succeeded: 3,
      pending: 0,
      progress: 1,
    });

    expect(await inApp(() => Job.findBatch(batch.id))).toMatchObject({
      succeeded: 3,
      finishedAt: expect.any(Number),
    });
    // From any job class, too.
    expect(await inApp(() => BuildPage.findBatch(batch.id))).toMatchObject({ id: batch.id });
  });

  test("a failed job cancels the rest, runs catch and finally, and not then", async () => {
    const { BuildPage, ImportFinished, built, finished } = fixtures();
    const { inApp } = await booted([BuildPage, ImportFinished], { concurrency: 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const batch = await inApp(() =>
      BuildPage.dispatchBatch(
        [
          ["bad-1", "imp"],
          ["b", "imp"],
          ["c", "imp"],
        ],
        {
          then: ImportFinished.with("then"),
          catch: ImportFinished.with("catch"),
          finally: ImportFinished.with("finally"),
        },
      ),
    );

    await until(() => finished.length === 2);
    await sleep(20);
    expect(finished.map((call) => call.label)).toEqual(["catch", "finally"]);
    expect(built).toEqual([]);
    const status = await inApp(() => Job.findBatch(batch.id));
    expect(status).toMatchObject({ failed: 1, cancelled: 2, pending: 0 });
    expect(status!.failedJobIds).toHaveLength(1);
  });

  test("allowFailures keeps going and still runs then", async () => {
    const { BuildPage, ImportFinished, built, finished } = fixtures();
    const { inApp } = await booted([BuildPage, ImportFinished]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await inApp(() =>
      BuildPage.dispatchBatch(
        [
          ["a", "imp"],
          ["bad-1", "imp"],
          ["c", "imp"],
        ],
        { allowFailures: true, then: ImportFinished.with("then") },
      ),
    );

    await until(() => finished.length === 1);
    expect(built.sort()).toEqual(["imp:a", "imp:c"]);
    expect(finished[0]!.status).toMatchObject({ succeeded: 2, failed: 1 });
  });

  test("this.progress() reports into the batch's progress, and this.batch is the batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: Array<{ id: string | undefined }> = [];

    class Slow extends Job {
      static name = "Slow";
      async run() {
        seen.push({ id: this.batch?.id });
        await this.progress(0.5);
        await gate;
      }
    }
    const { inApp } = await booted([Slow], { concurrency: 4 });

    const batch = await inApp(() => Slow.dispatchBatch([[], []]));
    await until(() => seen.length === 2);
    await until(async () => (await inApp(() => Job.findBatch(batch.id)))!.progress === 0.5);
    expect(seen).toEqual([{ id: batch.id }, { id: batch.id }]);

    release();
    await until(async () => (await inApp(() => Job.findBatch(batch.id)))!.progress === 1);
  });

  test("a job dispatched on its own has no batch, and its progress() does nothing", async () => {
    const seen: unknown[] = [];
    class Alone extends Job {
      static name = "Alone";
      async run() {
        await this.progress(0.3);
        seen.push(this.batch);
      }
    }
    const { inApp } = await booted([Alone]);
    await inApp(() => Alone.dispatch());
    await until(() => seen.length === 1);
    expect(seen).toEqual([undefined]);
  });

  test("progress() refuses a value that is not a number", async () => {
    const job = new (class extends Job {})();
    await expect(job.progress(Number.NaN)).rejects.toThrow(TypeError);
  });

  test("cancelBatch stops the waiting jobs, and running ones can see it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runs: number[] = [];
    const sawCancel: boolean[] = [];
    const finished: string[] = [];

    class Step extends Job {
      static name = "Step";
      async run(n: number) {
        runs.push(n);
        await gate;
        sawCancel.push((await this.batch?.cancelled()) === true);
      }
    }
    class Done extends Job {
      static name = "Done";
      run(label: string) {
        finished.push(label);
      }
    }
    const { inApp } = await booted([Step, Done], { concurrency: 1 });

    const batch = await inApp(() =>
      Step.dispatchBatch([[1], [2], [3]], {
        then: Done.with("then"),
        catch: Done.with("catch"),
        finally: Done.with("finally"),
      }),
    );
    await until(() => runs.length === 1);

    expect(await inApp(() => Job.cancelBatch(batch.id))).toBe(true);
    expect(await inApp(() => Job.cancelBatch(batch.id))).toBe(false);
    release();

    await until(() => finished.length === 2);
    expect(runs).toEqual([1]);
    expect(sawCancel).toEqual([true]);
    expect(finished).toEqual(["catch", "finally"]);
    expect(await inApp(() => Job.findBatch(batch.id))).toMatchObject({
      succeeded: 1,
      cancelled: 2,
      pending: 0,
    });
  });

  test("a job of a cancelled batch claimed after the cancel is ended unrun", async () => {
    // The race `cancelBatch` cannot close on its own: a job claimed before
    // the cancel but not yet started. Played here by cancelling between the
    // claim and the run, through a driver that cancels as it hands out.
    const runs: number[] = [];
    class Step extends Job {
      static name = "Step";
      run(n: number) {
        runs.push(n);
      }
    }
    const { queue, inApp } = await booted([Step]);
    const driver = queue.driver as QueueDriver;
    const claim = driver.claim.bind(driver);
    vi.spyOn(driver, "claim").mockImplementation(async (limit, options) => {
      const claimed = await claim(limit, options);
      for (const job of claimed) if (job.batchId) await driver.cancelBatch!(job.batchId);
      return claimed;
    });

    const batch = await inApp(() => Step.dispatchBatch([[1]]));
    await until(async () => (await inApp(() => Job.findBatch(batch.id)))!.pending === 0);
    expect(runs).toEqual([]);
    expect(await inApp(() => Job.findBatch(batch.id))).toMatchObject({ cancelled: 1, failed: 0 });
  });

  test("a batch of nothing finishes at once", async () => {
    const { BuildPage, ImportFinished, finished } = fixtures();
    const { inApp } = await booted([BuildPage, ImportFinished]);

    const batch = await inApp(() =>
      BuildPage.dispatchBatch([], { then: ImportFinished.with("then") }),
    );
    expect(batch.total).toBe(0);
    await until(() => finished.length === 1);
    expect(finished[0]!.status).toMatchObject({ total: 0, progress: 1 });
  });

  test("refuses a worker job, a unique job and a job with no name, on the caller's stack", async () => {
    class OnThread extends Job {
      static name = "OnThread";
      worker = true;
      run() {}
    }
    class Unique extends Job {
      static name = "Unique";
      uniqueId(id: string) {
        return id;
      }
      run(_id: string) {}
    }
    class Nameless extends Job {
      static name = "unset";
      run() {}
    }
    const { inApp } = await booted([OnThread, Unique]);

    expect(() => inApp(() => OnThread.dispatchBatch([[]]))).toThrow("worker job");
    expect(() => inApp(() => Unique.dispatchBatch([["a"]]))).toThrow("unique");
    expect(() => inApp(() => Nameless.dispatchBatch([[]]))).toThrow("no name");
    expect(() => Nameless.with()).toThrow("no name");
  });

  test("refuses a callback that is not a job call", async () => {
    const { BuildPage } = fixtures();
    const { inApp } = await booted([BuildPage]);
    expect(() =>
      inApp(() => BuildPage.dispatchBatch([["a", "b"]], { then: (() => {}) as any })),
    ).toThrow("SomeJob.with");
  });

  test("with() throws for arguments JSON cannot carry, and does not dispatch", async () => {
    const { ImportFinished } = fixtures();
    const circular: any = {};
    circular.self = circular;
    expect(() => (ImportFinished as any).with(circular)).toThrow(TypeError);
    expect(ImportFinished.with("x")).toEqual({ name: "ImportFinished", args: ["x"] });
  });

  test("refuses a driver without batches", async () => {
    const { BuildPage } = fixtures();
    const plain: QueueDriver = {
      enqueue: async () => "id",
      claim: async () => [],
      complete: async () => {},
      fail: async () => {},
      release: async () => {},
    };
    const queue = new QueueManager({ driver: plain, jobs: [BuildPage] });
    expect(() => queue.pushBatch(BuildPage, ["[]"])).toThrow("does not support batches");
    await expect(queue.findBatch("x")).rejects.toThrow("does not support batches");
    await expect(queue.cancelBatch("x")).rejects.toThrow("does not support batches");
  });
});

describe("Job.dispatchBatch inside a transaction", () => {
  // The fake pool `QueueManager.transaction.test.ts` uses: `withTransaction`
  // only calls `begin` and `savepoint` on it.
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

  test("is held until the commit, on a driver that cannot join", async () => {
    const { BuildPage, built } = fixtures();
    const { queue, inApp } = await booted([BuildPage]);
    const enqueueBatch = vi.spyOn(queue.driver, "enqueueBatch" as never);

    let id: string | undefined;
    await inApp(() =>
      withTransaction(fakePool(), async () => {
        ({ id } = await BuildPage.dispatchBatch([["a", "imp"]]));
        expect(enqueueBatch).not.toHaveBeenCalled();
      }),
    );

    expect(enqueueBatch).toHaveBeenCalledTimes(1);
    await until(() => built.length === 1);
    expect(await inApp(() => Job.findBatch(id!))).toMatchObject({ succeeded: 1 });
  });

  test("is dropped when the transaction rolls back", async () => {
    const { BuildPage } = fixtures();
    const { queue, inApp } = await booted([BuildPage]);
    const enqueueBatch = vi.spyOn(queue.driver, "enqueueBatch" as never);

    let id: string | undefined;
    await expect(
      inApp(() =>
        withTransaction(fakePool(), async () => {
          ({ id } = await BuildPage.dispatchBatch([["a", "imp"]]));
          throw new Error("rolled back");
        }),
      ),
    ).rejects.toThrow("rolled back");

    expect(enqueueBatch).not.toHaveBeenCalled();
    expect(await inApp(() => Job.findBatch(id!))).toBeNull();
  });
});
