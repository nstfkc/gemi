import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { Repository } from "../../support/Repository";
import { Job } from "./Job";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { ClaimedJob, QueueDriver } from "./QueueDriver";
import { QueueManager, backoffFor } from "./QueueManager";
import { QueueServiceProvider } from "./QueueServiceProvider";

/**
 * The worker loop over a driver: claiming up to `concurrency`, ending every
 * claim, retrying with backoff, and stopping on `drain`.
 *
 * The registry and the unresolvable-name path are `QueueManager.test.ts`'s;
 * the driver's own promises are `queueDriverContract.ts`'s. What is left here
 * is what the manager decides.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A job whose every run waits for the test to release it. */
function gatedJob(name: string) {
  const started: unknown[] = [];
  const gates: Array<() => void> = [];
  const Gated = {
    [name]: class extends Job {
      static name = name;
      run(n: unknown) {
        started.push(n);
        return new Promise<void>((resolve) => gates.push(resolve));
      }
    },
  }[name]!;
  return { Gated, started, release: () => gates.shift()!() };
}

function failingJob(fields: { maxAttempts?: number; backoff?: number | number[] }) {
  const calls = { run: [] as number[], fail: 0, deadletter: [] as Error[] };
  class AlwaysThrows extends Job {
    static name = "AlwaysThrows";
    maxAttempts = fields.maxAttempts ?? 3;
    backoff = fields.backoff ?? 0;
    run() {
      calls.run.push(Date.now());
      throw new Error("smtp is down");
    }
    onFail() {
      calls.fail++;
    }
    onDeadletter(error: Error) {
      calls.deadletter.push(error);
    }
  }
  return { AlwaysThrows, calls };
}

describe("dispatch", () => {
  class ChargeCard extends Job {
    static name = "ChargeCard";
    run() {}
  }

  async function booted() {
    const application = new Application(new Repository({ queue: { jobs: [ChargeCard] } }));
    application.registerMany([QueueServiceProvider]);
    await application.boot();
    return application;
  }

  test("resolves to the id the driver recorded the job under", async () => {
    const application = await booted();
    const queue = application.make(QueueManager);
    const enqueue = vi.spyOn(queue.driver, "enqueue");

    const id = await kernelContext.run(application, () => ChargeCard.dispatch());

    expect(typeof id).toBe("string");
    expect(await enqueue.mock.results[0]!.value).toBe(id);
  });

  test("still throws on the caller's stack for arguments JSON cannot carry", async () => {
    const application = await booted();
    const circular: any = {};
    circular.self = circular;

    // Synchronously, not as a rejection: a caller that wrapped `dispatch` in a
    // try/catch when it returned `void` still catches this, and a caller that
    // ignores the promise does not get an unhandled rejection instead.
    expect(() =>
      kernelContext.run(application, () => (ChargeCard as any).dispatch(circular)),
    ).toThrow(TypeError);
  });
});

describe("concurrency", () => {
  test("runs no more than `concurrency` at once, and starts the next the moment one ends", async () => {
    const { Gated, started, release } = gatedJob("Gated");
    const queue = new QueueManager({ jobs: [Gated], concurrency: 2 });

    for (const n of [1, 2, 3]) queue.push(Gated, JSON.stringify([n]));
    await settle();

    expect(started).toEqual([1, 2]);
    expect(queue.running).toBe(2);

    // Well under the one-second poll the loop used to sleep in while full: a
    // freed slot wakes it.
    release();
    await sleep(20);
    expect(started).toEqual([1, 2, 3]);

    release();
    release();
    await settle();
    expect(queue.running).toBe(0);
  });

  test("a job reclaimed while its first run is still going counts both runs, and the stale one ending leaves the new one tracked", async () => {
    const { Gated, started, release } = gatedJob("Gated");
    const memory = new MemoryQueueDriver();
    // Heartbeats fail until the reclaim, standing in for a database blip that
    // lets a live lease lapse.
    let blip = true;
    const driver: QueueDriver = {
      enqueue: (job) => memory.enqueue(job),
      claim: (limit, options) => memory.claim(limit, options),
      complete: (job) => memory.complete(job),
      fail: (job, failure) => memory.fail(job, failure),
      heartbeat: (jobs, options) =>
        blip ? Promise.resolve() : memory.heartbeat(jobs, options),
      subscribe: (wake) => memory.subscribe(wake),
    };
    // A whole lease is 300ms and the manager beats every 100ms, so the second
    // run survives an event loop stalled for two missed beats. At the 60ms
    // this used to use, one 60ms stall anywhere in the window below lapsed a
    // lease that is supposed to be held and the job was claimed a third time —
    // a flake, not a finding.
    const queue = new QueueManager({
      jobs: [Gated],
      driver,
      concurrency: 2,
      visibilityTimeout: 300,
    });

    queue.push(Gated, JSON.stringify([1]));
    await vi.waitFor(() => expect(started).toHaveLength(2), {
      timeout: 3000,
      interval: 5,
    });
    blip = false;

    // Both runs are really running, so both hold a slot.
    expect(queue.running).toBe(2);

    // The stale first run ends. The second is still running, so it must stay
    // counted and heartbeated; were it forgotten, its lease would lapse too
    // and the job would be claimed a third time into the freed slot.
    release();
    // Longer than a whole lease, so an unheartbeated second run really would
    // be claimed again inside this window.
    await sleep(450);
    expect(started).toHaveLength(2);
    expect(queue.running).toBe(1);
    const { unfinished } = await queue.stop();
    expect(unfinished.map((job) => job.attempt)).toEqual([2]);

    release();
    await settle();
    expect(queue.running).toBe(0);
  });
});

describe("a job that always throws", () => {
  test("is attempted maxAttempts times, onFail each time, then dead-lettered once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { AlwaysThrows, calls } = failingJob({ maxAttempts: 3 });
    const queue = new QueueManager({ jobs: [AlwaysThrows] });

    queue.push(AlwaysThrows, "[]");
    await vi.waitFor(() => expect(calls.deadletter).toHaveLength(1));

    expect(calls.run).toHaveLength(3);
    expect(calls.fail).toBe(3);
    expect(calls.deadletter[0]!.message).toBe("smtp is down");
    expect((queue.driver as MemoryQueueDriver).waiting).toBe(0);
    expect((queue.driver as MemoryQueueDriver).leased).toBe(0);
  });

  test("waits out its backoff between attempts", async () => {
    const { AlwaysThrows, calls } = failingJob({
      maxAttempts: 3,
      backoff: [100, 200],
    });
    const queue = new QueueManager({ jobs: [AlwaysThrows] });

    queue.push(AlwaysThrows, "[]");
    await vi.waitFor(() => expect(calls.deadletter).toHaveLength(1), {
      timeout: 2000,
    });

    const [first, second, third] = calls.run;
    // A few milliseconds of slack for a timer that fires a hair early.
    expect(second! - first!).toBeGreaterThanOrEqual(95);
    expect(third! - second!).toBeGreaterThanOrEqual(195);
  });

  test("a throwing onFail does not keep the claim, or the slot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    class HookThrows extends Job {
      static name = "HookThrows";
      maxAttempts = 1;
      run() {
        throw new Error("run");
      }
      onFail() {
        throw new Error("hook");
      }
    }
    const { Gated, started } = gatedJob("After");
    const queue = new QueueManager({ jobs: [HookThrows, Gated] });

    queue.push(HookThrows, "[]");
    queue.push(Gated, "[1]");
    await settle();

    // With concurrency 1, the gated job only starts if the throwing hook's
    // attempt gave its slot back.
    expect(started).toEqual([1]);
    expect((queue.driver as MemoryQueueDriver).leased).toBe(1);
  });
});

describe("backoffFor", () => {
  test("a number is every retry's delay; an array is per retry, its last repeated", () => {
    expect(backoffFor(0, 1)).toBe(0);
    expect(backoffFor(500, 3)).toBe(500);
    expect([1, 2, 3, 4].map((n) => backoffFor([10, 20], n))).toEqual([10, 20, 20, 20]);
    expect(backoffFor([], 1)).toBe(0);
  });
});

/** A driver that hands out whatever the test says, and records reports. */
function scriptedDriver(claims: ClaimedJob[][]): QueueDriver & {
  failed: Array<[ClaimedJob, unknown]>;
} {
  const failed: Array<[ClaimedJob, unknown]> = [];
  return {
    failed,
    enqueue: async () => "id",
    claim: async () => claims.shift() ?? [],
    complete: async () => {},
    fail: async (job, failure) => void failed.push([job, failure]),
    release: async () => {},
  };
}

describe("a job claimed past its last attempt", () => {
  test("is dead-lettered without running, because an earlier attempt died with its process", async () => {
    const ran = vi.fn();
    const deadletter = vi.fn();
    class Flaky extends Job {
      static name = "Flaky";
      maxAttempts = 3;
      run = ran;
      onDeadletter = deadletter;
    }
    const driver = scriptedDriver([
      [{ id: "j1", name: "Flaky", args: '["x"]', attempt: 4, createdAt: 0 }],
    ]);
    const queue = new QueueManager({ jobs: [Flaky], driver, pollInterval: 5 });

    queue.start();
    await vi.waitFor(() => expect(driver.failed).toHaveLength(1));
    await queue.stop();

    expect(ran).not.toHaveBeenCalled();
    expect(deadletter.mock.calls[0]![0].message).toContain("never finished");
    expect(deadletter.mock.calls[0]![1]).toBe("x");
    expect(driver.failed[0]![1]).toMatchObject({ retryInMs: null });
  });

  test("but a maxAttempts below one still gets its one attempt", async () => {
    const ran = vi.fn();
    class Once extends Job {
      static name = "Once";
      maxAttempts = 0;
      run = ran;
    }
    const driver = scriptedDriver([
      [{ id: "j1", name: "Once", args: "[]", attempt: 1, createdAt: 0 }],
    ]);
    const queue = new QueueManager({ jobs: [Once], driver, pollInterval: 5 });

    queue.start();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1));
    await queue.stop();
  });
});

describe("waking", () => {
  class Noop extends Job {
    static name = "Noop";
    run() {}
  }

  test("a subscribing driver wakes the loop for a job it was handed directly", async () => {
    const queue = new QueueManager({ jobs: [Noop] });
    const ran = vi.spyOn(Noop.prototype, "run");
    queue.start();
    await settle();

    // Not through `push`: the shape of a job another process enqueued into
    // shared storage, which this one only hears about from the driver.
    await queue.driver.enqueue({ name: "Noop", args: "[]" });
    await settle();

    expect(ran).toHaveBeenCalledTimes(1);
  });

  test("a driver without subscribe is polled every pollInterval", async () => {
    const memory = new MemoryQueueDriver();
    const polled: QueueDriver = {
      enqueue: (job) => memory.enqueue(job),
      claim: (limit, options) => memory.claim(limit, options),
      complete: (job) => memory.complete(job),
      fail: (job, failure) => memory.fail(job, failure),
    };
    const claim = vi.spyOn(polled, "claim");
    const queue = new QueueManager({
      jobs: [Noop],
      driver: polled,
      pollInterval: 20,
    });
    const ran = vi.spyOn(Noop.prototype, "run");
    queue.start();
    await settle();

    await memory.enqueue({ name: "Noop", args: "[]" });
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), {
      timeout: 500,
    });
    await queue.stop();

    // More than the first claim: it got there by polling.
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  test("a claim that rejects is retried on a timer, even on a subscribing driver", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memory = new MemoryQueueDriver();
    let blip = false;
    const driver: QueueDriver = {
      enqueue: (job) => memory.enqueue(job),
      claim: (limit, options) => {
        if (blip) {
          blip = false;
          return Promise.reject(new Error("connection reset"));
        }
        return memory.claim(limit, options);
      },
      complete: (job) => memory.complete(job),
      fail: (job, failure) => memory.fail(job, failure),
      subscribe: (wake) => memory.subscribe(wake),
    };
    const queue = new QueueManager({
      jobs: [Noop],
      driver,
      pollInterval: 20,
    });
    const ran = vi.spyOn(Noop.prototype, "run");

    queue.start();
    await settle();

    // The shape a LISTEN/NOTIFY driver has: the only wake this worker will
    // ever get for this job is the enqueue's, and the claim that wake prompted
    // is the one that dies. The worker is idle, so no in-flight job's `wake`
    // is coming either — without a timer the job waits for an unrelated
    // enqueue that a quiet queue may never see.
    blip = true;
    await memory.enqueue({ name: "Noop", args: "[]" });

    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    await queue.stop();
  });
});

describe("a job that cannot be constructed", () => {
  test("is dead-lettered on its first claim, not reclaimed once per lease forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    class Unbuildable extends Job {
      static name = "Unbuildable";
      // What `private mailer = app(Mailer)` does when nothing is bound: the
      // throw is the instance's, so there is never an instance.
      broken = (() => {
        throw new Error("app(Mailer) is not bound");
      })();
      run() {}
    }
    const memory = new MemoryQueueDriver();
    const claim = vi.spyOn(memory, "claim");
    const queue = new QueueManager({
      jobs: [Unbuildable],
      driver: memory,
      visibilityTimeout: 30,
    });

    queue.push(Unbuildable, "[]");
    await sleep(300);
    await queue.stop();

    // Nothing waiting and nothing leased: the claim was ended. Left to the
    // generic `could not record the outcome` path it never is, and the job is
    // reclaimed every 30ms — the reviewer measured thirteen claims in 400ms —
    // climbing past `maxAttempts` without ever reaching the guard, because
    // that guard needs the instance that cannot be built.
    expect(memory.waiting).toBe(0);
    expect(memory.leased).toBe(0);
    expect(claim.mock.calls.length).toBeLessThan(5);
  });
});

describe("drain", () => {
  test("stops claiming, and waits for what is running", async () => {
    const { Gated, started, release } = gatedJob("Gated");
    const queue = new QueueManager({ jobs: [Gated], concurrency: 1 });

    queue.push(Gated, "[1]");
    queue.push(Gated, "[2]");
    await settle();

    const drained = queue.drain();
    release();
    const result = await drained;

    expect(result.unfinished).toEqual([]);
    // The second was waiting, not running, and is still waiting: nothing was
    // claimed after the drain began.
    await settle();
    expect(started).toEqual([1]);
    expect((queue.driver as MemoryQueueDriver).waiting).toBe(1);
  });

  test("reports what did not finish before the timeout, without cancelling it", async () => {
    const { Gated, release } = gatedJob("Gated");
    const queue = new QueueManager({ jobs: [Gated], concurrency: 2 });

    const id = await queue.push(Gated, "[1]");
    await settle();

    const result = await queue.drain(20);

    expect(result.unfinished).toMatchObject([{ id, name: "Gated", attempt: 1 }]);
    expect(queue.running).toBe(1);
    release();
    await settle();
    expect(queue.running).toBe(0);
  });

  test("a push after it is recorded but not run, until start()", async () => {
    const { Gated, started, release } = gatedJob("Gated");
    const queue = new QueueManager({ jobs: [Gated] });
    await queue.stop();

    await queue.push(Gated, "[1]");
    await settle();
    expect(started).toEqual([]);

    queue.start();
    await settle();
    expect(started).toEqual([1]);
    release();
  });
});

describe("the context a job runs in", () => {
  const request = new AsyncLocalStorage<string>();

  test("is not the dispatching request's, for the first dispatch or any later one", async () => {
    const seen: Array<string | undefined> = [];
    class ReadsContext extends Job {
      static name = "ReadsContext";
      run() {
        seen.push(request.getStore());
      }
    }
    const queue = new QueueManager({ jobs: [ReadsContext] });

    // The first dispatch starts the long-lived loop. Started in its caller's
    // context, it would carry "alice" into every job after — including
    // bob's.
    await request.run("alice", () => queue.push(ReadsContext, "[]"));
    await settle();
    await request.run("bob", () => queue.push(ReadsContext, "[]"));
    await settle();

    expect(seen).toEqual([undefined, undefined]);
  });

  test("has the manager's application entered, so app() inside a job resolves it", async () => {
    const application = new Application(new Repository({}));
    let seen: unknown;
    class ReadsApp extends Job {
      static name = "ReadsApp";
      run() {
        seen = kernelContext.getStore();
      }
    }
    const queue = new QueueManager({ jobs: [ReadsApp] }, { application });

    queue.push(ReadsApp, "[]");
    await settle();

    expect(seen).toBe(application);
  });
});

describe("the driver option", () => {
  test("a factory is called once per manager, so two applications never share a queue", () => {
    const factory = vi.fn(() => new MemoryQueueDriver());

    const a = new QueueManager({ driver: factory });
    const b = new QueueManager({ driver: factory });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(a.driver).not.toBe(b.driver);
  });

  test("an instance is used as given", () => {
    const driver = new MemoryQueueDriver();
    expect(new QueueManager({ driver }).driver).toBe(driver);
  });

  test("an unknown name is refused at construction, not at the first dispatch", () => {
    expect(() => new QueueManager({ driver: "redis" as "memory" })).toThrow(
      'Unknown queue driver "redis"',
    );
  });
});
