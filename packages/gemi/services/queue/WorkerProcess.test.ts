import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { isShuttingDown, resetShuttingDown } from "../../server/shutdown";
import { Repository } from "../../support/Repository";
import { Job } from "./Job";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { QueueConfig } from "./config";
import { markQueueWorker, QueueManager } from "./QueueManager";
import { QueueServiceProvider } from "./QueueServiceProvider";
import { QueueWorker, QueueWorkerRefused, type WorkerKernel } from "./WorkerProcess";

/**
 * `gemi queue:work` in-process: a kernel is stood in for by a bare
 * `Application` with only the queue provider, which is also what proves the
 * worker resolves nothing the application did not bind. The real process —
 * the entry point, the signal, the exit — is in `work.test.ts`.
 */

const env = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  resetShuttingDown();
  markQueueWorker(false);
  globalThis.__gemiDevQueue = undefined;
  for (const key of ["NODE_ENV", "ROOT_DIR", "GEMI_QUEUE_CLAIM"] as const) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function kernel(queue: QueueConfig | undefined): WorkerKernel {
  const app = new Application(new Repository({ queue: { jobs: [], ...queue } }));
  if (queue) app.registerMany([QueueServiceProvider]);
  return {
    app,
    waitForBoot: () => app.boot(),
    shutdown: (options) => app.shutdown(options),
  };
}

/** A durable driver as far as the queue can tell: not the memory one. */
function durable(kept: MemoryQueueDriver) {
  return {
    enqueue: kept.enqueue.bind(kept),
    claim: kept.claim.bind(kept),
    complete: kept.complete.bind(kept),
    fail: kept.fail.bind(kept),
    heartbeat: kept.heartbeat.bind(kept),
    subscribe: kept.subscribe.bind(kept),
  };
}

function gated() {
  const started: number[] = [];
  const gates: Array<() => void> = [];
  class Gated extends Job {
    static name = "Gated";
    run(n: number) {
      started.push(n);
      return new Promise<void>((resolve) => gates.push(resolve));
    }
  }
  return { Gated, started, release: () => gates.shift()!() };
}

/** The process as `work.ts` leaves it before booting: a worker, in development. */
function aWorker() {
  process.env.NODE_ENV = "development";
  process.env.ROOT_DIR = "/srv/app";
  markQueueWorker();
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("starting a worker", () => {
  test("claims what is waiting with no dispatch, in development too", async () => {
    aWorker();
    const { Gated, started, release } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[1]" });
    const worker = new QueueWorker(kernel({ jobs: [Gated], driver: () => durable(kept) }));

    await worker.start();
    await vi.waitFor(() => expect(started).toEqual([1]));

    release();
    expect(await worker.stop()).toBe(0);
  });

  test("claims even when GEMI_QUEUE_CLAIM=off, which is for the web process", async () => {
    aWorker();
    process.env.GEMI_QUEUE_CLAIM = "off";
    const { Gated, started, release } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[1]" });
    const worker = new QueueWorker(kernel({ jobs: [Gated], driver: () => durable(kept) }));

    await worker.start();
    await vi.waitFor(() => expect(started).toEqual([1]));

    release();
    await worker.stop();
  });

  test("refuses the memory driver, which no other process can dispatch into", async () => {
    aWorker();
    const host = kernel({});
    const worker = new QueueWorker(host);

    await expect(worker.start()).rejects.toThrow(QueueWorkerRefused);
    await expect(worker.start()).rejects.toThrow("memory driver");
    expect(globalThis.__gemiDevQueue).toBeUndefined();
  });

  test("refuses an application without the queue provider, resolving nothing unbound", async () => {
    aWorker();
    const host = kernel(undefined);
    expect(host.app.bound(QueueManager)).toBe(false);

    await expect(new QueueWorker(host).start()).rejects.toThrow(
      "does not register QueueServiceProvider",
    );
  });

  test("does not start claiming when a signal arrived during the boot", async () => {
    aWorker();
    const { Gated, started } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[1]" });
    const host = kernel({ jobs: [Gated], driver: () => durable(kept) });
    let finishBoot!: () => void;
    const booting = new Promise<void>((resolve) => (finishBoot = resolve));
    const worker = new QueueWorker({
      ...host,
      waitForBoot: async () => {
        await booting;
        await host.app.boot();
      },
    });

    const starting = worker.start();
    const stopping = worker.stop();
    finishBoot();
    await starting;
    await sleep(20);

    expect(started).toEqual([]);
    expect(kept.waiting).toBe(1);
    expect(await stopping).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain(
      "Queue worker started",
    );
  });
});

describe("stopping a worker", () => {
  test("stops claiming at once and waits for the jobs running, then the providers", async () => {
    aWorker();
    const { Gated, started, release } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[1]" });
    await kept.enqueue({ name: "Gated", args: "[2]" });
    const host = kernel({ jobs: [Gated], driver: () => durable(kept) });
    const shutdown = vi.spyOn(host, "shutdown");
    const worker = new QueueWorker(host, { timeoutMs: 2_000, providerTimeoutMs: 1_000 });
    await worker.start();
    await vi.waitFor(() => expect(started).toEqual([1]));

    let code: number | undefined;
    const stopping = worker.stop().then((c) => (code = c));
    await sleep(20);
    expect(isShuttingDown()).toBe(true);
    expect(code).toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(code).toBe(0);
    expect(shutdown).toHaveBeenCalledWith({ timeoutMs: 1_000 });
    // The second job was left in the driver for another worker.
    expect(started).toEqual([1]);
    expect(kept.waiting).toBe(1);
  });

  test("exits 1 when a job outlives both budgets, and the queue names it", async () => {
    aWorker();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Gated, started, release } = gated();
    const kept = new MemoryQueueDriver();
    await kept.enqueue({ name: "Gated", args: "[1]" });
    const worker = new QueueWorker(kernel({ jobs: [Gated], driver: () => durable(kept) }), {
      timeoutMs: 20,
      providerTimeoutMs: 50,
    });
    await worker.start();
    await vi.waitFor(() => expect(started).toEqual([1]));

    expect(await worker.stop()).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("Gated");
    release();
  });

  test("is idempotent: a repeated signal is the same shutdown", async () => {
    aWorker();
    const host = kernel({ driver: () => durable(new MemoryQueueDriver()) });
    const shutdown = vi.spyOn(host, "shutdown");
    const worker = new QueueWorker(host);
    await worker.start();

    const first = worker.stop();
    expect(worker.stop()).toBe(first);
    expect(await first).toBe(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
