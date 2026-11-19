import { describe, expect, test as vitestTest, vi } from "vitest";

import type { BatchStatus } from "../batch";
import { Job } from "../Job";
import type { QueueDriver } from "../QueueDriver";
import { QueueManager } from "../QueueManager";
import { type EachSummary, type Step, StepFailedError, WaitTimeoutError } from "./Step";
import { Workflow, type WorkflowClass } from "./Workflow";
import type { WorkflowUpdate } from "./wire";
import { WORKFLOW_TICK_JOB, WorkflowLeaseLostError } from "./WorkflowStore";

/**
 * What workflows promise on every driver that keeps them, as a suite a
 * driver's test file runs against itself:
 *
 *     workflowContract("MemoryQueueDriver", async () => {
 *       const driver = new MemoryQueueDriver();
 *       return { driver: () => driver, dispose: async () => {} };
 *     });
 *
 * `storage` makes fresh, empty storage for one test. Its `driver()` returns
 * a driver over it, a new one per call where the storage is shared (a
 * database), so that two managers on two drivers are two processes. The
 * workflows run end to end, through `QueueManager`s that claim the ticks.
 *
 * Not a `*.test.ts` file, so vitest never runs it on its own.
 */
export function workflowContract(
  name: string,
  storage: () => Promise<{ driver(): QueueDriver; dispose(): Promise<void> }>,
  features: {
    /**
     * Runs the test with two managers ticking the same workflows. Off for
     * SQLite files: two clients in one thread are not two processes there,
     * because SQLite's busy handler sleeps the very thread the lock holder
     * needs to finish its transaction.
     */
    concurrentWorkers?: boolean;
    /** How many items the "long list" `step.each` test works through. Default 2,000. */
    largeCount?: number;
  } = { concurrentWorkers: true },
) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
      await sleep(10);
    }
  }

  /** Runs `body` with a fresh storage and the managers it starts, then cleans up. */
  const withQueue =
    (
      body: (queue: {
        worker(workflows: WorkflowClass[], jobs?: Array<new () => Job>, config?: object): QueueManager;
        driver(): QueueDriver;
      }) => Promise<void>,
    ) =>
    async () => {
      const store = await storage();
      const managers: QueueManager[] = [];
      try {
        await body({
          driver: () => store.driver(),
          worker(workflows, jobs = [], config = {}) {
            const manager = new QueueManager({
              driver: store.driver(),
              jobs,
              workflows,
              concurrency: 4,
              pollInterval: 20,
              ...config,
            });
            managers.push(manager);
            manager.start();
            return manager;
          },
        });
      } finally {
        await Promise.all(managers.map((manager) => manager.drain(5_000)));
        await Promise.all(managers.map((manager) => manager.workflows.close()));
        await store.dispose();
      }
    };

  const status = (queue: QueueManager, id: string) =>
    queue.workflows.find(id).then((found) => found?.status);

  // Real ticks through real queues, on databases too: generous.
  const test = (title: string, fn: () => Promise<void>, timeout = 30_000) =>
    vitestTest(title, fn, timeout);

  describe(`${name} — workflows`, () => {
    test(
      "runs each step once across passes, and stores the result",
      withQueue(async ({ worker }) => {
        const runs: string[] = [];
        let passes = 0;
        class Greet extends Workflow {
          static name = "Greet";
          async run(step: Step, who: string) {
            passes++;
            const greeting = await step.run("greet", () => {
              runs.push("greet");
              return `hello ${who}`;
            });
            await step.sleep("pause", 30);
            const shout = await step.run("shout", () => {
              runs.push("shout");
              return greeting.toUpperCase();
            });
            return { shout, at: new Date(0) };
          }
        }
        const queue = worker([Greet]);
        const id = await queue.workflows.start(Greet, ["ada"]);

        await until(async () => (await status(queue, id)) === "completed");
        const found = await queue.workflows.find(id);

        expect(runs).toEqual(["greet", "shout"]);
        expect(passes).toBe(2);
        // As JSON makes it, the Date included.
        expect(found).toMatchObject({
          id,
          name: "Greet",
          status: "completed",
          args: ["ada"],
          progress: 1,
          currentStep: null,
          error: null,
          result: { shout: "HELLO ADA", at: "1970-01-01T00:00:00.000Z" },
        });
        expect(found!.steps.map((step) => [step.key, step.status])).toEqual([
          ["greet", "completed"],
          ["pause", "completed"],
          ["shout", "completed"],
        ]);
      }),
    );

    test(
      "a failing step is retried on its own, then throws StepFailedError into run",
      withQueue(async ({ worker }) => {
        let calls = 0;
        const attempts: number[] = [];
        let caught: unknown;
        class Flaky extends Workflow {
          static name = "Flaky";
          async run(step: Step) {
            const value = await step.run(
              "flaky",
              (ctx) => {
                attempts.push(ctx.attempt);
                if (++calls < 3) throw new Error(`boom ${calls}`);
                return calls;
              },
              { attempts: 3, backoff: [20, 0] },
            );
            try {
              await step.run("doomed", () => {
                throw new Error("never");
              }, { attempts: 2 });
            } catch (error) {
              caught = error;
            }
            return value;
          }
        }
        const queue = worker([Flaky]);
        const id = await queue.workflows.start(Flaky, []);
        await until(async () => (await status(queue, id)) === "completed");

        expect(attempts).toEqual([1, 2, 3]);
        expect(caught).toBeInstanceOf(StepFailedError);
        expect((caught as StepFailedError).step).toBe("doomed");
        expect((caught as Error).message).toContain("never");
        const found = await queue.workflows.find(id);
        expect(found!.result).toBe(3);
        expect(found!.steps.find((step) => step.key === "doomed")).toMatchObject({
          status: "failed",
          attempt: 2,
        });
      }),
    );

    test(
      "an error that escapes run fails the workflow",
      withQueue(async ({ worker }) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        class Broken extends Workflow {
          static name = "Broken";
          async run(step: Step) {
            await step.run("fails", () => {
              throw new Error("nope");
            }, { attempts: 1 });
          }
        }
        const queue = worker([Broken]);
        const id = await queue.workflows.start(Broken, []);
        await until(async () => (await status(queue, id)) === "failed");
        expect((await queue.workflows.find(id))!.error).toContain("nope");
      }),
    );

    test(
      "a sleep holds no process: the workflow is sleeping until it is due",
      withQueue(async ({ worker }) => {
        const after = vi.fn();
        class Nap extends Workflow {
          static name = "Nap";
          async run(step: Step) {
            await step.sleep("nap", 400);
            await step.run("after", after);
          }
        }
        const queue = worker([Nap]);
        const started = Date.now();
        const id = await queue.workflows.start(Nap, []);

        await until(async () => (await status(queue, id)) === "sleeping");
        expect((await queue.workflows.find(id))!.currentStep).toBe("nap");
        // The tick that put it to sleep ends, and nothing runs while it sleeps.
        await until(() => queue.running === 0);
        expect(await status(queue, id)).toBe("sleeping");
        await until(async () => (await status(queue, id)) === "completed");
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        expect(after).toHaveBeenCalledTimes(1);
      }),
    );

    test(
      "waitFor resumes on a signal with its payload, and a second signal is refused",
      withQueue(async ({ worker }) => {
        class Approve extends Workflow {
          static name = "Approve";
          async run(step: Step) {
            const pages = await step.waitFor<string[]>("pages-chosen");
            return pages.length;
          }
        }
        const queue = worker([Approve]);
        const id = await queue.workflows.start(Approve, []);
        await until(async () => (await status(queue, id)) === "waiting");

        expect(await queue.workflows.signal(id, "pages-chosen", ["p1", "p3"])).toBe(true);
        expect(await queue.workflows.signal(id, "pages-chosen", ["again"])).toBe(false);
        await until(async () => (await status(queue, id)) === "completed");
        expect((await queue.workflows.find(id))!.result).toBe(2);
        expect(await queue.workflows.signal("no-such-workflow", "pages-chosen")).toBe(false);
        expect(await queue.workflows.signal(id, "late", 1)).toBe(false);
      }),
    );

    test(
      "a signal that arrives before waitFor is kept until the workflow gets there",
      withQueue(async ({ worker }) => {
        class Early extends Workflow {
          static name = "Early";
          async run(step: Step) {
            await step.sleep("first", 200);
            return step.waitFor("go");
          }
        }
        const queue = worker([Early]);
        const id = await queue.workflows.start(Early, []);
        await until(async () => (await status(queue, id)) === "sleeping");

        expect(await queue.workflows.signal(id, "go", { ok: true })).toBe(true);
        await until(async () => (await status(queue, id)) === "completed");
        expect((await queue.workflows.find(id))!.result).toEqual({ ok: true });
      }),
    );

    test(
      "waitFor throws WaitTimeoutError once its timeout passes",
      withQueue(async ({ worker }) => {
        class Impatient extends Workflow {
          static name = "Impatient";
          async run(step: Step) {
            try {
              await step.waitFor("reply", { timeout: 150 });
              return "replied";
            } catch (error) {
              return error instanceof WaitTimeoutError ? "timed out" : "other";
            }
          }
        }
        const queue = worker([Impatient]);
        const id = await queue.workflows.start(Impatient, []);
        await until(async () => (await status(queue, id)) === "completed");
        const found = await queue.workflows.find(id);
        expect(found!.result).toBe("timed out");
        expect(found!.steps[0]).toMatchObject({ key: "reply", status: "timed_out" });
        expect(await queue.workflows.signal(id, "reply", 1)).toBe(false);
      }),
    );

    test(
      "step.batch dispatches once and resumes when every job has ended",
      withQueue(async ({ worker }) => {
        const built: string[] = [];
        class BuildPage extends Job {
          static name = "BuildPage";
          maxAttempts = 1;
          async run(page: string) {
            if (page === "bad") throw new Error("cannot build bad");
            built.push(page);
          }
        }
        let passes = 0;
        class Import extends Workflow {
          static name = "Import";
          async run(step: Step, pages: string[]) {
            passes++;
            const batch = await step.batch(
              "build",
              BuildPage,
              pages.map((page) => [page] as const),
              { allowFailures: true },
            );
            return { failed: batch.failedJobIds.length, succeeded: batch.succeeded };
          }
        }
        vi.spyOn(console, "error").mockImplementation(() => {});
        const queue = worker([Import], [BuildPage]);
        const id = await queue.workflows.start(Import, [["a", "bad", "c"]]);
        await until(async () => (await status(queue, id)) === "completed");

        expect(built.sort()).toEqual(["a", "c"]);
        expect((await queue.workflows.find(id))!.result).toEqual({ failed: 1, succeeded: 2 });
        // Dispatched in the first pass, resumed by the batch in the second
        // (or a third, when the batch ended while the first was letting go).
        expect(passes).toBeGreaterThanOrEqual(2);
        const step = (await queue.workflows.find(id))!.steps[0]!;
        expect(step).toMatchObject({ key: "build", status: "completed", progress: 1 });
        expect(await queue.findBatch(step.batchId!)).toMatchObject({ total: 3, pending: 0 });
      }),
    );

    test(
      "a batch that fails without allowFailures throws StepFailedError with its status",
      withQueue(async ({ worker }) => {
        class Page extends Job {
          static name = "Page";
          maxAttempts = 1;
          async run(page: string) {
            if (page === "bad") throw new Error("bad page");
          }
        }
        let batch: BatchStatus | undefined;
        class Strict extends Workflow {
          static name = "Strict";
          async run(step: Step) {
            try {
              await step.batch("pages", Page, [["bad"], ["b"]]);
            } catch (error) {
              batch = (error as StepFailedError).batch;
              throw error;
            }
          }
        }
        vi.spyOn(console, "error").mockImplementation(() => {});
        const queue = worker([Strict], [Page], { concurrency: 1 });
        const id = await queue.workflows.start(Strict, []);
        await until(async () => (await status(queue, id)) === "failed");
        expect(batch).toMatchObject({ failed: 1, total: 2 });
        expect((await queue.workflows.find(id))!.error).toContain("failed");
      }),
    );

    test(
      "cancel while waiting runs onCancel once, and the workflow ends cancelled",
      withQueue(async ({ worker }) => {
        const compensated: string[] = [];
        class Order extends Workflow {
          static name = "Order";
          async run(step: Step, orderId: string) {
            await step.run("reserve", () => orderId);
            await step.waitFor("paid");
          }
          async onCancel(step: Step, orderId: string) {
            await step.run("release", () => compensated.push(orderId));
          }
        }
        const queue = worker([Order]);
        const id = await queue.workflows.start(Order, ["o-1"]);
        await until(async () => (await status(queue, id)) === "waiting");

        expect(await queue.workflows.cancel(id)).toBe(true);
        expect(await queue.workflows.cancel(id)).toBe(false);
        expect(await queue.workflows.signal(id, "paid", true)).toBe(false);
        await until(async () => (await status(queue, id)) === "cancelled");
        await sleep(100);
        expect(compensated).toEqual(["o-1"]);
        expect(await queue.workflows.cancel(id)).toBe(false);
        expect(await queue.workflows.cancel("no-such-workflow")).toBe(false);
      }),
    );

    test(
      "cancel cancels a running step.batch, and aborts a running step through ctx.signal",
      withQueue(async ({ worker }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        class Slow extends Job {
          static name = "Slow";
          async run() {
            await gate;
          }
        }
        let aborted: unknown;
        class Fanout extends Workflow {
          static name = "Fanout";
          async run(step: Step, mode: string) {
            if (mode === "batch") {
              await step.batch("slow", Slow, [[], [], [], [], [], []]);
            } else {
              await step.run("long", (ctx) =>
                new Promise((_, reject) => {
                  ctx.signal.addEventListener("abort", () => {
                    aborted = ctx.signal.reason;
                    reject(ctx.signal.reason);
                  });
                }),
              );
            }
          }
          onCancel() {}
        }
        const queue = worker([Fanout], [Slow], { concurrency: 2 });

        const batched = await queue.workflows.start(Fanout, ["batch"]);
        await until(async () => (await status(queue, batched)) === "waiting");
        const batchId = (await queue.workflows.find(batched))!.steps[0]!.batchId!;
        expect(await queue.workflows.cancel(batched)).toBe(true);
        // The jobs already running hold both slots until they finish.
        release();
        await until(async () => (await status(queue, batched)) === "cancelled");
        expect(await queue.findBatch(batchId)).toMatchObject({
          cancelledAt: expect.any(Number),
        });
        expect((await queue.findBatch(batchId))!.cancelled).toBeGreaterThan(0);

        const running = await queue.workflows.start(Fanout, ["step"]);
        await until(async () => (await queue.workflows.find(running))?.currentStep === "long");
        expect(await queue.workflows.cancel(running)).toBe(true);
        await until(async () => (await status(queue, running)) === "cancelled");
        expect((aborted as Error)?.name).toBe("WorkflowCancelledError");
      }),
    );

    test(
      "progress is what step.progress last set, and 1 once completed",
      withQueue(async ({ worker }) => {
        class Halfway extends Workflow {
          static name = "Halfway";
          async run(step: Step) {
            await step.progress(0.5);
            await step.waitFor("go");
          }
        }
        const queue = worker([Halfway]);
        const id = await queue.workflows.start(Halfway, []);
        await until(async () => (await status(queue, id)) === "waiting");
        expect((await queue.workflows.find(id))!.progress).toBe(0.5);
        await queue.workflows.signal(id, "go");
        await until(async () => (await status(queue, id)) === "completed");
        expect((await queue.workflows.find(id))!.progress).toBe(1);
      }),
    );

    (features.concurrentWorkers === false ? describe.skip : describe)("two workers", () => test(
      "two workers never run one workflow's steps twice",
      withQueue(async ({ worker, driver }) => {
        const runs: string[] = [];
        class Busy extends Workflow {
          static name = "Busy";
          async run(step: Step, n: number) {
            for (let i = 0; i < 3; i++) {
              await step.run(`s${i}`, async () => {
                runs.push(`${n}:${i}`);
                await sleep(5);
              });
              await step.sleep(`z${i}`, 10);
            }
          }
        }
        const a = worker([Busy]);
        worker([Busy]);
        const ids = await Promise.all(
          Array.from({ length: 6 }, (_, n) => a.workflows.start(Busy, [n])),
        );
        // Extra ticks, as signals landing mid-pass enqueue: they must
        // coalesce rather than run a second pass beside the first.
        const producer = driver();
        for (const id of ids) {
          for (let i = 0; i < 3; i++) {
            await producer.enqueue({ name: WORKFLOW_TICK_JOB, args: JSON.stringify([id]) });
          }
        }
        await until(
          async () =>
            (await Promise.all(ids.map((id) => status(a, id)))).every((s) => s === "completed"),
          20_000,
        );
        expect(runs.sort()).toEqual(
          Array.from({ length: 6 }, (_, n) => [0, 1, 2].map((i) => `${n}:${i}`)).flat().sort(),
        );
      }),
    ));

    test(
      "a tick that lost its hold cannot write, and a busy tick is coalesced",
      withQueue(async ({ driver }) => {
        const store = driver().workflowStore!();
        await store.create({ id: "wf-1", name: "Nobody", args: "[]" });

        const first = await store.acquire("wf-1", "job-a:1", 60_000);
        expect(first.kind).toBe("acquired");
        // A retry of the same tick job takes it straight back, and the
        // earlier attempt's writes are refused from then on.
        expect((await store.acquire("wf-1", "job-a:2", 60_000)).kind).toBe("acquired");
        await expect(
          store.update("wf-1", { owner: "job-a:1" }, () => ({ result: 1 })),
        ).rejects.toBeInstanceOf(WorkflowLeaseLostError);
        // Another tick job while it is held: busy, and marked.
        expect((await store.acquire("wf-1", "job-b:1", 60_000)).kind).toBe("busy");
        expect((await store.find("wf-1"))!.workflow.retick).toBe(true);

        // Letting go enqueues the tick the busy one gave up.
        const before = await countTicks(driver());
        await store.update("wf-1", { owner: "job-a:2" }, () => ({ result: 1, unlock: true }));
        expect(await countTicks(driver())).toBe(before + 1);
        const after = (await store.find("wf-1"))!.workflow;
        expect(after).toMatchObject({ lockedBy: null, retick: false });

        // A lapsed lease is free for anyone.
        expect((await store.acquire("wf-1", "job-c:1", 50)).kind).toBe("acquired");
        await sleep(120);
        expect((await store.acquire("wf-1", "job-d:1", 60_000)).kind).toBe("acquired");
        expect(await store.renew("wf-1", "job-c:1", 60_000)).toBe(false);
        expect(await store.renew("wf-1", "job-d:1", 60_000)).toBe(true);
      }),
    );
  });


  describe(`${name} — step.each`, () => {
    test(
      "works through every item once, with retries that do not hold up the list",
      withQueue(async ({ worker }) => {
        const calls: string[] = [];
        const keys = new Map<number, string>();
        let summary: EachSummary | undefined;
        class Rows extends Workflow {
          static name = "Rows";
          async run(step: Step, prefix: string) {
            const before = await step.run("before", () => "ready");
            summary = await step.each(
              "rows",
              {
                count: 8,
                item: (index) => ({ sku: `${prefix}-${index}`, index }),
                key: (row) => row.sku,
                attempts: 3,
                backoff: [40, 0],
              },
              async (row, ctx) => {
                calls.push(`${row.index}:${ctx.attempt}`);
                keys.set(row.index, ctx.idempotencyKey);
                expect(ctx.key).toBe(row.sku);
                if (row.index === 2 && ctx.attempt < 3) throw new Error(`flaky ${ctx.attempt}`);
                if (row.index === 4) throw new Error("always broken");
                if (row.index === 6) ctx.skip("no name", { line: 7 });
              },
            );
            return { before, summary };
          }
        }
        const queue = worker([Rows]);
        const id = await queue.workflows.start(Rows, ["sku"]);
        await until(async () => (await status(queue, id)) === "completed");

        // Item 2 waited out its backoff while 3, 5 and 7 ran.
        expect(calls.indexOf("2:2")).toBeGreaterThan(calls.indexOf("3:1"));
        expect(calls.filter((call) => call.startsWith("2:"))).toEqual(["2:1", "2:2", "2:3"]);
        expect(calls.filter((call) => call.startsWith("4:"))).toEqual(["4:1", "4:2", "4:3"]);
        for (const index of [0, 1, 3, 5, 6, 7]) {
          expect(calls.filter((call) => call.startsWith(`${index}:`))).toEqual([`${index}:1`]);
        }
        expect(keys.get(3)).toBe(`${id}:rows:sku-3`);
        expect(summary).toEqual({
          total: 8,
          done: 8,
          succeeded: 6,
          skipped: 1,
          failed: 1,
          moreProblems: false,
          problems: [
            { index: 4, key: "sku-4", status: "failed", reason: "always broken", attempt: 3 },
            { index: 6, key: "sku-6", status: "skipped", reason: "no name", data: { line: 7 }, attempt: 1 },
          ],
        });
        const found = await queue.workflows.find(id);
        expect(found!.result).toEqual({ before: "ready", summary });
        expect(found!.steps.find((step) => step.key === "rows")).toMatchObject({
          status: "completed",
          progress: 1,
          items: { total: 8, done: 8, succeeded: 6, skipped: 1, failed: 1 },
        });
        expect(await queue.workflows.items(id, "rows", { status: "failed" })).toEqual([
          { index: 4, key: "sku-4", status: "failed", reason: "always broken", attempt: 3 },
        ]);
        expect((await queue.workflows.items(id, "rows", { after: 4 })).map((p) => p.index)).toEqual([6]);
      }),
    );

    test(
      "a long list keeps rows only for its window and its problems",
      withQueue(async ({ worker }) => {
        const count = features.largeCount ?? 2_000;
        const concurrency = 4;
        let produced = 0;
        let handled = 0;
        let widest = 0;
        let store: ReturnType<NonNullable<QueueDriver["workflowStore"]>> | undefined;
        let workflowId = "";
        class Long extends Workflow {
          static name = "Long";
          async run(step: Step) {
            return step.each(
              "items",
              {
                count,
                concurrency,
                attempts: 1,
                item: (index) => {
                  produced++;
                  return index;
                },
              },
              async (index, ctx) => {
                handled++;
                if (index % 500 === 0) {
                  const open = await store!.listItems!(workflowId, "items", {
                    statuses: ["running", "retrying"],
                    limit: 10_000,
                  });
                  widest = Math.max(widest, open.length);
                }
                if (index % 997 === 0) throw new Error(`bad ${ctx.index}`);
              },
            );
          }
        }
        const queue = worker([Long]);
        store = queue.workflows.store;
        workflowId = await queue.workflows.start(Long, []);
        await until(async () => (await status(queue, workflowId)) === "completed", 120_000);

        const failures = Math.floor((count - 1) / 997) + 1;
        expect(produced).toBe(count);
        expect(handled).toBe(count);
        expect(widest).toBeLessThanOrEqual(concurrency);
        const rows = await store.listItems!(workflowId, "items", {
          statuses: ["running", "retrying", "failed", "skipped"],
          limit: count,
        });
        expect(rows.map((row) => row.index)).toEqual(
          Array.from({ length: failures }, (_, n) => n * 997),
        );
        expect((await queue.workflows.find(workflowId))!.result).toMatchObject({
          total: count,
          done: count,
          succeeded: count - failures,
          failed: failures,
        });
      }),
      180_000,
    );

    test(
      "a tick works for its budget, then the next tick goes on from the cursor",
      withQueue(async ({ worker }) => {
        let passes = 0;
        const seen: number[] = [];
        class Budgeted extends Workflow {
          static name = "Budgeted";
          async run(step: Step) {
            passes++;
            return step.each(
              "slow",
              { count: 12, item: (index) => index, tickBudget: 40 },
              async (index) => {
                seen.push(index);
                await sleep(15);
              },
            );
          }
        }
        const queue = worker([Budgeted]);
        const id = await queue.workflows.start(Budgeted, []);
        await until(async () => (await status(queue, id)) === "completed");
        expect(seen).toEqual(Array.from({ length: 12 }, (_, n) => n));
        expect(passes).toBeGreaterThanOrEqual(3);
      }),
    );

    test(
      "progress is readable through find while the list runs",
      withQueue(async ({ worker }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        class Gated extends Workflow {
          static name = "Gated";
          async run(step: Step) {
            return step.each("rows", { count: 4, item: (index) => index }, async (index) => {
              if (index === 2) await gate;
            });
          }
        }
        const queue = worker([Gated]);
        const id = await queue.workflows.start(Gated, []);
        await until(async () => (await queue.workflows.find(id))?.progress === 0.5);
        const found = await queue.workflows.find(id);
        expect(found).toMatchObject({ status: "running", currentStep: "rows", progress: 0.5 });
        expect(found!.steps[0]).toMatchObject({
          key: "rows",
          status: "iterating",
          progress: 0.5,
          items: { total: 4, done: 2, succeeded: 2, skipped: 0, failed: 0 },
        });
        release();
        await until(async () => (await status(queue, id)) === "completed");
      }),
    );

    test(
      "a tick that dies mid-list is taken over: only the item in flight runs again",
      withQueue(async ({ worker, driver }) => {
        const attempts = new Map<number, number[]>();
        const keys = new Map<number, Set<string>>();
        let hang: () => void = () => {};
        const hung = new Promise<void>((resolve) => (hang = resolve));
        // The owner holding the workflow when item 3 starts stops renewing
        // its hold: the process that ran it is gone, as far as anyone can tell.
        let lastOwner: string | undefined;
        let dead: string | undefined;
        const patch = (manager: QueueManager) => {
          const store = manager.workflows.store;
          const acquire = store.acquire.bind(store);
          const renew = store.renew.bind(store);
          store.acquire = async (id, owner, lease) => {
            const result = await acquire(id, owner, lease);
            if (result.kind === "acquired") lastOwner = owner;
            return result;
          };
          store.renew = async (id, owner, lease) =>
            owner === dead ? false : renew(id, owner, lease);
        };
        class Crashy extends Workflow {
          static name = "Crashy";
          async run(step: Step) {
            return step.each(
              "rows",
              { count: 6, item: (index) => index, key: (index) => `row-${index}` },
              async (index, ctx) => {
                attempts.set(index, [...(attempts.get(index) ?? []), ctx.attempt]);
                keys.set(index, (keys.get(index) ?? new Set()).add(ctx.idempotencyKey));
                if (index === 3 && ctx.attempt === 1) {
                  dead = lastOwner;
                  await hung;
                }
              },
            );
          }
        }
        const config = { visibilityTimeout: 300 };
        const a = worker([Crashy], [], config);
        patch(a);
        const id = await a.workflows.start(Crashy, []);
        await until(() => dead !== undefined);
        // A second process, where two clients are two processes.
        if (features.concurrentWorkers !== false) patch(worker([Crashy], [], config));
        // Once its lease lapses, the next tick (as a signal or a wake-up
        // would enqueue) takes the workflow over; one that comes too early is
        // only marked, so keep sending them until one gets through.
        const producer = driver();
        await until(async () => {
          if ((await status(a, id)) === "completed") return true;
          await producer.enqueue({ name: WORKFLOW_TICK_JOB, args: JSON.stringify([id]) });
          await sleep(150);
          return false;
        }, 15_000);
        hang();

        expect(attempts.get(3)).toEqual([1, 2]);
        expect(keys.get(3)).toEqual(new Set([`${id}:rows:row-3`]));
        for (const index of [0, 1, 2, 4, 5]) expect(attempts.get(index)).toEqual([1]);
        expect((await a.workflows.find(id))!.result).toMatchObject({ done: 6, succeeded: 6 });
        // The dead tick's late result is refused, and changes nothing.
        await sleep(100);
        expect((await a.workflows.find(id))!.result).toMatchObject({ done: 6, succeeded: 6 });
      }),
    );

    test(
      "an item whose attempts all died with their process is failed, not run forever",
      withQueue(async ({ driver, worker }) => {
        const store = driver().workflowStore!();
        await store.create({ id: "wf-each", name: "Doomed", args: "[]" });
        // As a tick that died while item 0 ran its last attempt leaves it.
        expect((await store.acquire("wf-each", "gone:1", 60_000)).kind).toBe("acquired");
        await store.update("wf-each", { owner: "gone:1", key: "rows" }, ({ now }) => ({
          result: undefined,
          step: {
            workflowId: "wf-each",
            key: "rows",
            status: "iterating",
            attempt: 0,
            output: JSON.stringify({ $each: { count: 2, next: 1, succeeded: 0, skipped: 0, failed: 0 } }),
            error: null,
            batchId: null,
            wakeAt: null,
            startedAt: now,
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          items: {
            step: "rows",
            insert: [
              {
                workflowId: "wf-each",
                step: "rows",
                index: 0,
                key: null,
                status: "running",
                attempt: 2,
                error: null,
                output: null,
                wakeAt: null,
                startedAt: now,
                finishedAt: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          unlock: true,
        }));
        const ran: number[] = [];
        class Doomed extends Workflow {
          static name = "Doomed";
          async run(step: Step) {
            return step.each("rows", { count: 2, item: (i) => i, attempts: 2 }, (index) => {
              ran.push(index);
            });
          }
        }
        const queue = worker([Doomed]);
        await until(async () => (await status(queue, "wf-each")) === "completed");
        expect(ran).toEqual([1]);
        expect((await queue.workflows.find("wf-each"))!.result).toMatchObject({
          done: 2,
          succeeded: 1,
          failed: 1,
          problems: [{ index: 0, status: "failed", attempt: 2 }],
        });
      }),
    );

    test(
      "cancel aborts the items in flight and runs onCancel with the summary so far",
      withQueue(async ({ worker }) => {
        let aborted: unknown;
        const undone: string[] = [];
        class Cancellable extends Workflow {
          static name = "Cancellable";
          async run(step: Step) {
            await step.each("rows", { count: 5, item: (i) => i }, (index, ctx) =>
              index < 2
                ? undefined
                : new Promise((_, reject) =>
                    ctx.signal.addEventListener("abort", () => {
                      aborted = ctx.signal.reason;
                      reject(ctx.signal.reason);
                    }),
                  ),
            );
          }
          async onCancel(step: Step) {
            await step.run("undo", () => undone.push("undo"));
          }
        }
        const queue = worker([Cancellable]);
        const id = await queue.workflows.start(Cancellable, []);
        await until(async () => (await queue.workflows.find(id))?.progress === 0.4);
        expect(await queue.workflows.cancel(id)).toBe(true);
        await until(async () => (await status(queue, id)) === "cancelled");
        expect((aborted as Error)?.name).toBe("WorkflowCancelledError");
        expect(undone).toEqual(["undo"]);
        expect((await queue.workflows.find(id))!.steps[0]!.items).toMatchObject({
          total: 5,
          done: 2,
        });
      }),
    );

    test(
      "an empty list completes at once, and a step.each key cannot be reused as another step",
      withQueue(async ({ worker }) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        class Empty extends Workflow {
          static name = "Empty";
          async run(step: Step, reuse: boolean) {
            const summary = await step.each("rows", { count: 0, item: (i) => i }, () => {});
            if (reuse) await step.run("rows", () => 1);
            return summary;
          }
        }
        const queue = worker([Empty]);
        const empty = await queue.workflows.start(Empty, [false]);
        await until(async () => (await status(queue, empty)) === "completed");
        expect((await queue.workflows.find(empty))!.result).toEqual({
          total: 0,
          done: 0,
          succeeded: 0,
          skipped: 0,
          failed: 0,
          problems: [],
          moreProblems: false,
        });
        const reused = await queue.workflows.start(Empty, [true]);
        await until(async () => (await status(queue, reused)) === "failed");
        expect((await queue.workflows.find(reused))!.error).toContain("rows");
      }),
    );
  });


  describe(`${name} — workflow updates`, () => {
    test(
      "every change is published to the workflow's channel, coalesced, and the last one always",
      withQueue(async ({ worker }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        class Streamed extends Workflow {
          static name = "Streamed";
          async run(step: Step, secret: string) {
            await step.each("rows", { count: 40, item: (index) => index }, async (index) => {
              if (index === 20) await gate;
            });
            return secret;
          }
        }
        const queue = worker([Streamed]);
        const id = await queue.workflows.start(Streamed, ["do not show"]);
        expect(queue.workflows.channel(id)).toBe(`gemi:workflow:${id}`);

        const seen: WorkflowUpdate[] = [];
        const following = (async () => {
          for await (const update of queue.workflows.subscribe(id)) seen.push(update);
        })();
        await until(() => seen.some((update) => update.progress === 0.5));
        release();
        await following;

        const last = seen.at(-1)!;
        expect(last).toMatchObject({ id, name: "Streamed", status: "completed", progress: 1 });
        expect(last.steps[0]).toMatchObject({ key: "rows", status: "completed" });
        expect(last).not.toHaveProperty("args");
        expect(last).not.toHaveProperty("result");
        // Coalesced: far fewer updates than the 80-odd writes, in order.
        expect(seen.length).toBeLessThan(20);
        const progress = seen.map((update) => update.progress);
        expect([...progress].sort((a, b) => a - b)).toEqual(progress);
        const times = seen.map((update) => update.updatedAt);
        expect(times.toSorted((a, b) => a - b)).toEqual(times);

        // An ended workflow yields once and ends; an unknown one yields nothing.
        const after: WorkflowUpdate[] = [];
        for await (const update of queue.workflows.subscribe(id)) after.push(update);
        expect(after.map((update) => update.status)).toEqual(["completed"]);
        for await (const update of queue.workflows.subscribe("no-such-workflow")) after.push(update);
        expect(after).toHaveLength(1);
      }),
    );
  });

  /** Ticks waiting in the driver, claimed and then ended here. */
  async function countTicks(driver: QueueDriver) {
    const claimed = await driver.claim(100, {
      visibilityTimeoutMs: 60_000,
      registered: { names: [WORKFLOW_TICK_JOB], graceMs: Infinity },
    });
    for (const job of claimed) await driver.release(job, { retryInMs: 0 });
    return claimed.filter((job) => job.name === WORKFLOW_TICK_JOB).length;
  }
}
