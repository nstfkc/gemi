import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../../foundation/Application";
import { kernelContext } from "../../../kernel/context";
import { withTransaction } from "../../../orm/context";
import { Repository } from "../../../support/Repository";
import { Job } from "../Job";
import { MemoryQueueDriver } from "../MemoryQueueDriver";
import { QueueManager } from "../QueueManager";
import { QueueServiceProvider } from "../QueueServiceProvider";
import { toMilliseconds } from "./duration";
import { resetEachWarnings, type Step, StepFailedError } from "./Step";
import { ItemSource } from "./ItemSource";
import { Workflow, type WorkflowClass } from "./Workflow";
import { workflowContract } from "./workflowContract";
import { WORKFLOW_TICK_JOB } from "./WorkflowStore";

workflowContract(
  "MemoryQueueDriver",
  async () => {
    const driver = new MemoryQueueDriver();
    return { driver: () => driver, dispose: async () => {} };
  },
  { concurrentWorkers: true, largeCount: 20_000 },
);

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(5);
  }
}

/** A booted application whose queue has `workflows`, and a runner for code inside it. */
async function booted(
  workflows: WorkflowClass[],
  queue: Record<string, unknown> = {},
) {
  const application = new Application(
    new Repository({ queue: { jobs: [], workflows, ...queue } }),
  );
  application.registerMany([QueueServiceProvider]);
  await application.boot();
  const inApp = <T>(fn: () => T) => kernelContext.run(application, fn);
  return { application, queue: application.make(QueueManager), inApp };
}

describe("Workflow", () => {
  test("start, signal, find and cancel through the class", async () => {
    class Checkout extends Workflow {
      static name = "Checkout";
      async run(step: Step, cartId: string, total: number) {
        const paid = await step.waitFor<{ ok: boolean }>("paid");
        return { cartId, total, paid: paid.ok };
      }
    }
    const { inApp } = await booted([Checkout]);

    const id = await inApp(() => Checkout.start("cart-1", 42));
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "waiting");
    expect(await inApp(() => Workflow.pause(id))).toBe(true);
    expect((await inApp(() => Workflow.find(id)))?.status).toBe("paused");
    expect(await inApp(() => Workflow.resume(id))).toBe(true);
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "waiting");
    expect(await inApp(() => Checkout.signal(id, "paid", { ok: true }))).toBe(true);
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "completed");

    expect(await inApp(() => Checkout.find(id))).toMatchObject({
      name: "Checkout",
      args: ["cart-1", 42],
      result: { cartId: "cart-1", total: 42, paid: true },
    });
    expect(await inApp(() => Workflow.cancel(id))).toBe(false);
    expect(await inApp(() => Workflow.find("missing"))).toBeNull();
  });

  test("code outside the steps runs on every pass; the steps once", async () => {
    const outside = vi.fn();
    const inside = vi.fn(() => "value");
    class Passes extends Workflow {
      static name = "Passes";
      async run(step: Step) {
        outside();
        await step.run("once", inside);
        await step.sleep("a", 5);
        outside();
        await step.sleep("b", 5);
        outside();
      }
    }
    const { inApp } = await booted([Passes]);
    const id = await inApp(() => Passes.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "completed");

    expect(inside).toHaveBeenCalledTimes(1);
    // Three passes: 1 + 2 + 3 calls of the code around the steps.
    expect(outside).toHaveBeenCalledTimes(6);
  });

  test("two steps with one key fail the workflow, saying why", async () => {
    class Twice extends Workflow {
      static name = "Twice";
      async run(step: Step) {
        await step.run("same", () => 1);
        await step.run("same", () => 2);
      }
    }
    const { inApp } = await booted([Twice]);
    const id = await inApp(() => Twice.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "failed");
    expect((await inApp(() => Workflow.find(id)))!.error).toContain('use the key "same"');
  });

  test("a key reused for another kind of step fails the workflow", async () => {
    let pass = 0;
    class Renamed extends Workflow {
      static name = "Renamed";
      async run(step: Step) {
        pass++;
        if (pass === 1) await step.sleep("k", 5);
        else await step.run("k", () => 1);
      }
    }
    const { inApp } = await booted([Renamed]);
    const id = await inApp(() => Renamed.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "failed");
    expect((await inApp(() => Workflow.find(id)))!.error).toContain("sleeping step");
  });

  test("a step's context carries its idempotency key and attempt", async () => {
    const seen: Array<{ key: string; attempt: number }> = [];
    class Charge extends Workflow {
      static name = "Charge";
      async run(step: Step) {
        await step.run("charge", (ctx) => {
          seen.push({ key: ctx.idempotencyKey, attempt: ctx.attempt });
          if (ctx.attempt === 1) throw new Error("declined");
        });
      }
    }
    const { inApp } = await booted([Charge]);
    const id = await inApp(() => Charge.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "completed");
    expect(seen).toEqual([
      { key: `${id}:charge`, attempt: 1 },
      { key: `${id}:charge`, attempt: 2 },
    ]);
  });

  test("a step's timeout counts as a failed attempt and aborts ctx.signal", async () => {
    let aborted: unknown;
    let caught: unknown;
    class Stuck extends Workflow {
      static name = "Stuck";
      async run(step: Step) {
        try {
          await step.run(
            "hang",
            (ctx) =>
              new Promise(() => {
                ctx.signal.addEventListener("abort", () => (aborted = ctx.signal.reason));
              }),
            { attempts: 1, timeout: 30 },
          );
        } catch (error) {
          caught = error;
        }
      }
    }
    const { inApp } = await booted([Stuck]);
    const id = await inApp(() => Stuck.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "completed");
    expect((aborted as Error).name).toBe("StepTimeoutError");
    expect(caught).toBeInstanceOf(StepFailedError);
  });

  test("a step that was running when its process died counts the attempt", async () => {
    // Simulates a crash: the store says attempt 1 of "work" started and never
    // finished, the way a tick killed mid-step leaves it.
    let ran = 0;
    class Crashy extends Workflow {
      static name = "Crashy";
      async run(step: Step) {
        await step.run("work", () => ran++, { attempts: 1 });
      }
    }
    const { queue } = await booted([Crashy]);
    const store = queue.workflows.store;
    await store.create({ id: "wf-crash", name: "Crashy", args: "[]" });
    await store.update("wf-crash", { key: "work" }, ({ now }) => ({
      result: undefined,
      step: {
        workflowId: "wf-crash",
        key: "work",
        status: "running",
        attempt: 1,
        output: null,
        error: null,
        batchId: null,
        wakeAt: null,
        startedAt: now,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    }));
    queue.start();
    await until(async () => (await queue.workflows.find("wf-crash"))?.status === "failed");
    expect(ran).toBe(0);
    expect((await queue.workflows.find("wf-crash"))!.error).toContain("never finished");
  });

  test("a result over the size limit fails the step without retrying it", async () => {
    let calls = 0;
    class Huge extends Workflow {
      static name = "Huge";
      async run(step: Step) {
        await step.run("big", () => {
          calls++;
          return "x".repeat(300 * 1024);
        });
      }
    }
    const { inApp } = await booted([Huge]);
    const id = await inApp(() => Huge.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "failed");
    expect(calls).toBe(1);
    expect((await inApp(() => Workflow.find(id)))!.error).toContain("limit");
  });

  test("a workflow nobody registered fails on the memory driver, saying why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    class Known extends Workflow {
      static name = "Known";
    }
    const { queue } = await booted([Known]);
    await queue.workflows.store.create({ id: "wf-x", name: "Gone", args: "[]" });
    queue.start();
    await until(async () => (await queue.workflows.find("wf-x"))?.status === "failed");
    expect((await queue.workflows.find("wf-x"))!.error).toContain('"Gone"');
  });

  test("a start inside a transaction is held until it commits, and dropped on rollback", async () => {
    const ran = vi.fn();
    class Held extends Workflow {
      static name = "Held";
      async run(step: Step, n: number) {
        await step.run("go", () => ran(n));
      }
    }
    const { inApp, queue } = await booted([Held]);
    // An ORM transaction needs a client; the memory driver never joins it, so
    // any client that can open one will do.
    const { SQL } = await import("bun");
    const sql = new SQL("sqlite://:memory:");
    let committed = "";
    await inApp(() =>
      withTransaction(sql, async () => {
        committed = await Held.start(1);
        expect(await queue.workflows.find(committed)).toBeNull();
      }),
    );
    await until(async () => (await queue.workflows.find(committed))?.status === "completed");

    let rolledBack = "";
    await expect(
      inApp(() =>
        withTransaction(sql, async () => {
          rolledBack = await Held.start(2);
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");
    await sleep(50);
    expect(await queue.workflows.find(rolledBack)).toBeNull();
    expect(ran.mock.calls).toEqual([[1]]);
    await sql.close();
  });

  test("the tick job is registered once there is a workflow, and not in registeredJobs", async () => {
    class One extends Workflow {
      static name = "One";
    }
    const { queue } = await booted([One]);
    expect(queue.jobs[WORKFLOW_TICK_JOB]).toBeDefined();
    expect(queue.registeredJobs).toEqual([]);
    expect(queue.registeredWorkflows).toEqual([One]);

    const empty = await booted([]);
    expect(empty.queue.jobs[WORKFLOW_TICK_JOB]).toBeUndefined();
  });

  test("start refuses a class with no name, and a driver without workflows", async () => {
    class Nameless extends Workflow {
      static name = "unset";
    }
    const { inApp } = await booted([]);
    expect(() => inApp(() => Nameless.start())).toThrow("no name");

    class Named extends Workflow {
      static name = "Named";
    }
    const bare = new QueueManager({
      driver: {
        enqueue: async () => "id",
        claim: async () => [],
        complete: async () => {},
        fail: async () => {},
        release: async () => {},
      },
    });
    expect(() => bare.workflows.start(Named, [])).toThrow("does not support workflows");
  });

  test("step.batch refuses a worker job on the caller's stack, failing the workflow", async () => {
    class Threaded extends Job {
      static name = "Threaded";
      worker = true;
    }
    class UsesThread extends Workflow {
      static name = "UsesThread";
      async run(step: Step) {
        await step.batch("t", Threaded, [[]]);
      }
    }
    const { inApp } = await booted([UsesThread], { jobs: [Threaded] });
    const id = await inApp(() => UsesThread.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "failed");
    expect((await inApp(() => Workflow.find(id)))!.error).toContain("worker job");
  });

  test("steps started together in a pass all finish within it", async () => {
    const done: string[] = [];
    class Parallel extends Workflow {
      static name = "Parallel";
      async run(step: Step) {
        const [a, b] = await Promise.all([
          step.run("a", async () => {
            await sleep(20);
            done.push("a");
            return 1;
          }),
          step.run("b", () => {
            done.push("b");
            return 2;
          }),
        ]);
        return a + b;
      }
    }
    const { inApp } = await booted([Parallel]);
    const id = await inApp(() => Parallel.start());
    await until(async () => (await inApp(() => Workflow.find(id)))?.status === "completed");
    expect(done.sort()).toEqual(["a", "b"]);
    expect((await inApp(() => Workflow.find(id)))!.result).toBe(3);
  });
});

describe("toMilliseconds", () => {
  test("reads numbers and units, and refuses anything else", () => {
    expect(toMilliseconds(250)).toBe(250);
    expect(toMilliseconds("500ms")).toBe(500);
    expect(toMilliseconds("30s")).toBe(30_000);
    expect(toMilliseconds("5m")).toBe(300_000);
    expect(toMilliseconds("1.5h")).toBe(5_400_000);
    expect(toMilliseconds("7d")).toBe(604_800_000);
    expect(toMilliseconds("1w")).toBe(604_800_000);
    expect(() => toMilliseconds(-1)).toThrow();
    expect(() => toMilliseconds("soon" as never)).toThrow("not a duration");
  });
});

describe("step.each on a queue that keeps nothing across restarts", () => {
  test("warns once in production, and not in development", async () => {
    resetEachWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class List extends Workflow {
      static name = "List";
      async run(step: Step) {
        return step.each("items", { count: 2, item: (index) => index }, () => {});
      }
    }
    const { queue } = await booted([List]);
    queue.start();

    const first = await queue.workflows.start(List, []);
    await until(async () => (await queue.workflows.find(first))?.status === "completed");
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "production");
    try {
      const ids = [await queue.workflows.start(List, []), await queue.workflows.start(List, [])];
      for (const id of ids) {
        await until(async () => (await queue.workflows.find(id))?.status === "completed");
      }
    } finally {
      vi.unstubAllEnvs();
      await queue.drain(1_000);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("memory driver");
  });
});

describe("Workflow.stream", () => {
  test("an SSE response of the workflow's updates, from a cursor", async () => {
    class Waits extends Workflow {
      static name = "Waits";
      async run(step: Step, secret: string) {
        await step.waitFor("go");
        return secret;
      }
    }
    const { queue, inApp } = await booted([Waits]);
    queue.start();
    try {
      const id = await inApp(() => Waits.start("hidden"));
      await until(async () => (await queue.workflows.find(id))?.status === "waiting");
      await sleep(300);
      expect(await inApp(() => Workflow.channel(id))).toBe(`gemi:workflow:${id}`);
      const cursor = await inApp(() => Workflow.cursor(id));
      const abort = new AbortController();
      const response = inApp(() =>
        Workflow.stream(new Request("http://app.test/progress", { signal: abort.signal }), id, {
          cursor,
        }),
      );
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      await inApp(() => Workflow.signal(id, "go"));

      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes('"status":"completed"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      abort.abort();
      const updates = text
        .split("\n\n")
        .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
        .filter((line): line is string => line !== undefined)
        .map((line) => JSON.parse(line.slice(6)))
        .filter((message) => message.type === "change")
        .map((message) => message.data);
      expect(updates.at(-1)).toMatchObject({ id, status: "completed", progress: 1 });
      // Never the arguments or the result.
      expect(text).not.toContain("hidden");
    } finally {
      await queue.drain(1_000);
      await queue.workflows.close();
    }
  });
});

describe("ItemSource", () => {
  test("write, read, readRange, delete and prune through the facade", async () => {
    const { inApp } = await booted([]);
    async function* rows() {
      for (let i = 0; i < 3; i++) yield { sku: `s${i}` };
    }
    expect(await inApp(() => ItemSource.write("csv:1", rows()))).toEqual({ id: "csv:1", count: 3 });
    expect(await inApp(() => ItemSource.read("csv:1", 1))).toEqual({ sku: "s1" });
    expect(await inApp(() => ItemSource.read("csv:1", 9))).toBeUndefined();
    expect(await inApp(() => ItemSource.readRange("csv:1", 1, 3))).toEqual([{ sku: "s1" }, { sku: "s2" }]);
    expect(await inApp(() => ItemSource.delete("csv:1"))).toBe(3);
    await inApp(() => ItemSource.write("csv:2", [1, 2]));
    await sleep(5);
    expect(await inApp(() => ItemSource.prune(0))).toBe(2);
  });
});
