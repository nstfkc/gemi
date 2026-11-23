import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, workerData } from "node:worker_threads";

/**
 * What a job thread is handed as `workerData`, so the application booting in
 * it can tell it is one. See `isJobThread`.
 */
const JOB_THREAD = "gemi.queue.job-thread";

/**
 * Whether this code runs in a `worker = true` job's thread (#1325).
 *
 * The thread boots the whole application, every provider included, and a
 * provider that starts something long-lived at boot would start a second copy
 * of it there: the cron schedule firing every job twice, or a queue loop
 * claiming jobs into a thread that exists to run one at a time. Those
 * providers ask this. It reads `workerData`, which only the pool sets, rather
 * than `isMainThread` alone, so an application booted in some other thread —
 * a test runner's, say — is not mistaken for one.
 */
export function isJobThread(): boolean {
  return !isMainThread && (workerData as { gemi?: unknown } | null)?.gemi === JOB_THREAD;
}

/**
 * Where a job thread finds the application (#1318).
 *
 * An app's own bootstrap is used when it exists: `app/bootstrap.ts` under
 * development, `dist/server/bootstrap.mjs` (which `gemi build` emits from it)
 * in production. Otherwise the thread does what `gemi queue:work` does:
 * `new App({ kernel })` from `app/kernel/Kernel.ts`, with `App` resolved from
 * the application's own gemi, the copy its kernel extends.
 */
export function workerEntry(env: Record<string, string | undefined> = process.env): {
  bootstrap: string | undefined;
  kernel: string;
  app: string;
} {
  const rootDir = env.ROOT_DIR ?? process.cwd();
  const appDir = env.APP_DIR ?? `${rootDir}/app`;
  const bootstrap =
    env.NODE_ENV === "production"
      ? `${rootDir}/dist/server/bootstrap.mjs`
      : `${appDir}/bootstrap.ts`;
  let app: string;
  try {
    app = Bun.resolveSync("gemi/app", rootDir);
  } catch {
    // Run from outside a project (a test, a script): this copy's own,
    // through the package's reference to itself.
    app = Bun.resolveSync("gemi/app", __dirname);
  }
  return {
    bootstrap: existsSync(bootstrap) ? bootstrap : undefined,
    kernel: `${appDir}/kernel/Kernel.ts`,
    app,
  };
}

/**
 * The source of a job thread. It boots the application once, posts `ready`,
 * and then runs one job per message, for as long as the pool keeps it.
 *
 * Every job runs on the one booted application, as jobs on the main thread
 * share the server's: `dispatchJob` enters it around `run`. Nothing is torn
 * down between jobs — that teardown is what made every job pay for a boot.
 *
 * The `await` on `dispatchJob` is load-bearing. `postMessage` structured-clones
 * its argument and a Promise is not cloneable, so an un-awaited `dispatchJob`
 * posted nothing at all and the job never settled. A result that cannot be
 * cloned (a function, a class with private state) is reported as the job's
 * error instead of being lost the same way.
 */
function threadSource() {
  const entry = workerEntry();
  const load = entry.bootstrap
    ? `const { app } = await import(${JSON.stringify(entry.bootstrap)});`
    : `const { App } = await import(${JSON.stringify(entry.app)});
const { default: Kernel } = await import(${JSON.stringify(entry.kernel)});
const app = new App({ kernel: Kernel });
await app.waitForBoot();`;
  return `
const flat = (err) =>
  err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : { name: "Error", message: String(err), stack: undefined };
${load}
self.onmessage = async (event) => {
  const { id, jobName, args } = event.data;
  let message;
  try {
    message = { id, result: await app.dispatchJob(jobName, args) };
  } catch (err) {
    message = { id, error: flat(err) };
  }
  try {
    self.postMessage(message);
  } catch (err) {
    self.postMessage({
      id,
      error: flat(new Error(jobName + " returned a value its thread cannot send back: " + (err?.message ?? err))),
    });
  }
};
self.postMessage({ ready: true });
`;
}

/** A job that did not finish within its `workerTimeout`. */
export class WorkerTimeoutError extends Error {
  name = "WorkerTimeoutError";
}

/** How many job threads a pool keeps when the config does not say. */
export function defaultWorkerThreads(cores = availableParallelism()) {
  return Math.max(1, Math.min(2, cores - 1));
}

type Task = {
  id: number;
  jobName: string;
  args: string;
  timeoutMs: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type Slot = {
  worker: Worker;
  state: "booting" | "idle" | "busy";
  /** The job this thread was started for, or is running. */
  task: Task | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type WorkerPoolOptions = {
  /** At most this many threads at once. */
  size: number;
  /** How long a thread may take to boot the application before its job fails. */
  bootTimeoutMs: number;
  /** The thread's source; the application's by default. For tests. */
  source?: () => string;
};

/**
 * The threads `worker = true` jobs run in (#1325).
 *
 * Booting the application is most of what a job thread costs: a production
 * bundle is several megabytes, and loading it and booting every provider took
 * seconds of CPU and a few hundred megabytes for a job whose own work was half
 * a second. So a thread is kept once it has booted and runs the next job too.
 *
 * - **Lazy.** No thread exists until a worker job runs, and the pool grows one
 *   thread per job waiting for one, up to `size`. Jobs beyond that wait here
 *   for the first free thread.
 * - **One job per thread at a time**, so a CPU-bound job has its core.
 * - **A thread that fails is replaced.** One that crashes, errors outside a
 *   job, or exits fails the job it was running — only that one — and is
 *   dropped; the next waiting job starts a new thread. One that cannot boot
 *   fails the job it was started for, so an application that cannot load
 *   fails its jobs (which then retry and dead-letter) rather than spinning.
 * - **A job past its timeout** has its thread terminated, since a thread
 *   cannot be interrupted in the middle of `run`, and fails with
 *   `WorkerTimeoutError`.
 * - **Idle threads do not hold the process open**: they are unref'd until
 *   they are given a job.
 */
export class WorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly waiting: Task[] = [];
  private nextId = 0;
  private closed = false;
  /**
   * Set by `retireWhenIdle`: the pool that takes this one's waiting jobs, and
   * its threads end as their jobs finish.
   */
  private successor: { run: WorkerPool["run"] } | undefined;

  constructor(private readonly options: WorkerPoolOptions) {}

  /** The threads alive right now, booting ones included. */
  get threads(): number {
    return this.slots.size;
  }

  run(jobName: string, args: string, timeoutMs: number): Promise<unknown> {
    if (this.successor) return this.successor.run(jobName, args, timeoutMs);
    if (this.closed) {
      return Promise.reject(new Error(`The worker pool was closed, so ${jobName} did not run.`));
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ id: this.nextId++, jobName, args, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /**
   * Ends every thread. Jobs still running or waiting fail; the queue's own
   * `drain` is what waits for them first.
   */
  close() {
    this.closed = true;
    for (const task of this.waiting.splice(0)) {
      task.reject(new Error(`The worker pool was closed before ${task.jobName} ran.`));
    }
    for (const slot of this.slots) {
      this.retire(slot, new Error(`The worker pool was closed while ${slot.task?.jobName} ran.`));
    }
  }

  /**
   * Hands this pool over to `successor`: jobs waiting here, and any run
   * later, go to it; idle threads end now, and busy ones once their job is
   * done, so a job already running finishes rather than failing. A thread
   * still booting ends too, its job going to the successor. See `adoptPool`.
   */
  retireWhenIdle(successor: { run: WorkerPool["run"] }) {
    this.successor = successor;
    for (const task of this.waiting.splice(0)) this.forward(task);
    for (const slot of this.slots) {
      if (slot.state === "busy") continue;
      const task = slot.task;
      slot.task = undefined;
      this.retire(slot, undefined);
      if (task) this.forward(task);
    }
  }

  private forward(task: Task) {
    this.successor!.run(task.jobName, task.args, task.timeoutMs).then(task.resolve, task.reject);
  }

  private pump() {
    if (this.successor) {
      for (const task of this.waiting.splice(0)) this.forward(task);
      return;
    }
    while (this.waiting.length > 0) {
      const idle = [...this.slots].find((slot) => slot.state === "idle");
      if (idle) {
        this.assign(idle, this.waiting.shift()!);
      } else if (this.slots.size < Math.max(1, this.options.size)) {
        this.spawn(this.waiting.shift()!);
      } else {
        return;
      }
    }
  }

  private spawn(task: Task) {
    const url = URL.createObjectURL(
      new File([(this.options.source ?? threadSource)()], "gemi-job-thread.ts"),
    );
    const worker = new Worker(url, { workerData: { gemi: JOB_THREAD } } as WorkerOptions);
    const slot: Slot = { worker, state: "booting", task, timer: undefined };
    this.slots.add(slot);

    if (Number.isFinite(this.options.bootTimeoutMs)) {
      slot.timer = setTimeout(() => {
        this.retire(
          slot,
          new WorkerTimeoutError(
            `The thread for ${task.jobName} did not boot the application within ` +
              `${this.options.bootTimeoutMs} ms (queue.workerBootTimeout).`,
          ),
        );
      }, this.options.bootTimeoutMs);
    }

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { ready: true }
        | { id: number; result?: unknown; error?: { name: string; message: string; stack?: string } };
      if ("ready" in data) {
        // Retired while it booted (its boot timed out, say): the job it was
        // started for has been failed or handed on already.
        if (!this.slots.has(slot)) return;
        clearTimeout(slot.timer);
        slot.timer = undefined;
        URL.revokeObjectURL(url);
        if (slot.task) this.assign(slot, slot.task);
        else this.idle(slot);
        return;
      }
      const current = slot.task;
      if (!current || current.id !== data.id) return;
      clearTimeout(slot.timer);
      slot.timer = undefined;
      slot.task = undefined;
      if (data.error) current.reject(revive(data.error));
      else current.resolve(data.result);
      if (this.successor) {
        this.retire(slot, undefined);
        return;
      }
      this.idle(slot);
      this.pump();
    };
    worker.onerror = (event) => {
      const error = (event as ErrorEvent).error ?? (event as ErrorEvent).message ?? event;
      const name = slot.task?.jobName;
      this.retire(
        slot,
        error instanceof Error
          ? error
          : new Error(`The worker thread for ${name} failed: ${String(error)}`),
      );
    };
    worker.addEventListener("close", () => {
      this.retire(
        slot,
        new Error(`The worker thread for ${slot.task?.jobName} exited before the job finished.`),
      );
    });
  }

  private assign(slot: Slot, task: Task) {
    slot.state = "busy";
    slot.task = task;
    holdsProcess(slot.worker, true);
    if (Number.isFinite(task.timeoutMs) && task.timeoutMs > 0) {
      slot.timer = setTimeout(() => {
        this.retire(
          slot,
          new WorkerTimeoutError(
            `${task.jobName} did not finish within its workerTimeout of ${task.timeoutMs} ms; ` +
              `its thread was terminated.`,
          ),
        );
      }, task.timeoutMs);
    }
    slot.worker.postMessage({ id: task.id, jobName: task.jobName, args: task.args });
  }

  private idle(slot: Slot) {
    slot.state = "idle";
    holdsProcess(slot.worker, false);
  }

  /**
   * Drops a thread: fails the job it holds, if any, terminates it, and lets
   * the next waiting job start a replacement. Safe to call twice; `terminate`
   * itself fires `close`, which lands here again.
   */
  private retire(slot: Slot, error: Error | undefined) {
    if (!this.slots.delete(slot)) return;
    clearTimeout(slot.timer);
    const task = slot.task;
    slot.task = undefined;
    slot.worker.terminate();
    if (task) task.reject(error ?? new Error(`The thread running ${task.jobName} was ended.`));
    if (!this.closed) this.pump();
  }
}

/** Bun's `Worker.ref`/`unref`, which the DOM `Worker` type in scope lacks. */
function holdsProcess(worker: Worker, hold: boolean) {
  const handle = worker as unknown as { ref?(): void; unref?(): void };
  if (hold) handle.ref?.();
  else handle.unref?.();
}

function revive(flat: { name: string; message: string; stack?: string }) {
  const error = new Error(flat.message);
  error.name = flat.name;
  if (flat.stack) error.stack = flat.stack;
  return error;
}

const POOL = Symbol.for("gemi.queue.workerPool");

/**
 * Hands the process's pool over when a `bun --hot` reload builds a new one.
 *
 * A reload re-evaluates this module and boots a new application, whose queue
 * makes a new pool; the previous pool's threads hold the application as it
 * was before the save, a few hundred megabytes each. A pool from another
 * evaluation of this module is retired when the new one is made: its idle
 * threads end at once, and a job one is running finishes on its old code. A second pool
 * from the same module (two applications in one process, as tests build) is
 * left alone.
 */
export function adoptPool(pool: WorkerPool) {
  const previous = poolStore()[POOL];
  if (previous && previous.owner !== WorkerPool) previous.pool.retireWhenIdle(pool);
  poolStore()[POOL] = { pool, owner: WorkerPool };
}

/**
 * Whether the process holds a pool from before a `bun --hot` reload. The dev
 * boot asks, so the stale threads are let go as soon as the new application
 * is up rather than at its first worker job.
 */
export function hasStalePool() {
  const previous = poolStore()[POOL];
  return previous !== undefined && previous.owner !== WorkerPool;
}

function poolStore() {
  return globalThis as {
    [POOL]?: { pool: { retireWhenIdle(successor: { run: WorkerPool["run"] }): void }; owner: unknown };
  };
}
