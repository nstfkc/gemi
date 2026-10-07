import { backoffFor } from "../backoff";
import { type BatchStatus, clampProgress } from "../batch";
import type { EnqueueBatch } from "../QueueDriver";
import type { Job } from "../Job";
import { type Duration, toMilliseconds } from "./duration";
import {
  type StepRecord,
  type StepRunStatus,
  WORKFLOW_OUTPUT_LIMIT,
  type WorkflowChange,
  WorkflowLeaseLostError,
  type WorkflowSnapshot,
  type WorkflowStore,
} from "./WorkflowStore";

/** What a `step.run` function is handed. */
export type StepContext = {
  /**
   * `<workflow id>:<step key>`: the same on every attempt of this step, and
   * different for every other step. Pass it to a payment provider, say, so
   * that an attempt repeated after a crash is not charged twice.
   */
  idempotencyKey: string;
  /** Which attempt this is, counting from 1. */
  attempt: number;
  /**
   * Aborted when the step's `timeout` passes or the workflow is cancelled.
   * Pass it to `fetch` and friends. The workflow stops waiting for the step
   * at that moment, whether or not the function notices.
   */
  signal: AbortSignal;
};

export type StepRunOptions = {
  /** How many attempts the step gets, counting the first. Default 3. */
  attempts?: number;
  /**
   * Milliseconds to wait before each retry: one number for every retry, or
   * one per retry with the last repeated, as `Job.backoff`. Default 0. A
   * retry with a delay suspends the workflow until it is due.
   */
  backoff?: number | number[];
  /** How long one attempt may take before it counts as failed. */
  timeout?: Duration;
};

export type StepWaitOptions = {
  /**
   * How long to wait for the signal. Past it, `waitFor` throws a
   * `WaitTimeoutError`. Without it, the workflow waits until it is signalled
   * or cancelled.
   */
  timeout?: Duration;
};

export type StepBatchOptions = {
  /** A label kept with the batch. Default `workflow:<id>:<key>`. */
  name?: string;
  /**
   * Whether a failed job leaves the rest running. Default `false`: the first
   * dead-lettered job cancels the batch and `step.batch` throws a
   * `StepFailedError`. With `true`, `step.batch` returns the status, failed
   * jobs and all.
   */
  allowFailures?: boolean;
};

/** A step that ran out of attempts, or a batch that failed. */
export class StepFailedError extends Error {
  constructor(
    /** The step's key. */
    readonly step: string,
    message: string,
    /** The batch's final status, for a `step.batch` that failed. */
    readonly batch?: BatchStatus,
  ) {
    super(message);
    this.name = "StepFailedError";
  }
}

/** A `step.waitFor` whose `timeout` passed before the signal arrived. */
export class WaitTimeoutError extends Error {
  constructor(readonly step: string) {
    super(`No signal "${step}" arrived before its timeout.`);
    this.name = "WaitTimeoutError";
  }
}

/** Why a step's `ctx.signal` was aborted by its `timeout`. */
export class StepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`Step "${step}" took longer than its timeout of ${timeoutMs}ms.`);
    this.name = "StepTimeoutError";
  }
}

/** Why a step's `ctx.signal` was aborted by `Workflow.cancel`. */
export class WorkflowCancelledError extends Error {
  constructor(id: string) {
    super(`Workflow ${id} was cancelled.`);
    this.name = "WorkflowCancelledError";
  }
}

/**
 * Thrown through the workflow's code when a step cannot finish in this tick
 * (a sleep, a wait, a batch, a retry with a delay), so the tick can end and
 * the workflow resume later. Not exported: code that catches everything
 * should rethrow what it does not know, and the tick treats the workflow as
 * suspended even if this is swallowed.
 */
export class WorkflowSuspended extends Error {
  constructor() {
    super(
      "The workflow is suspended until a step can continue. Rethrow this " +
        "error if you catch it.",
    );
    this.name = "WorkflowSuspended";
  }
}

/** What the runtime gives the steps of one tick. */
export type StepTick = {
  workflowId: string;
  /** The tick's hold on the workflow; every write is fenced by it. */
  owner: string;
  store: WorkflowStore;
  /** The steps as they were when the tick took the workflow. */
  steps: StepRecord[];
  /** This tick runs `onCancel`, not `run`. */
  cancelling: boolean;
  findBatch(id: string): Promise<BatchStatus | null>;
  buildBatch(
    job: new () => Job,
    args: ReadonlyArray<ReadonlyArray<unknown>>,
    options: { name: string; allowFailures: boolean },
  ): EnqueueBatch;
  /** Jobs were recorded: wake the queue. */
  scheduled(): void;
  /** How often a running step checks whether the workflow was cancelled. */
  cancelCheckMs: number;
};

/** Why a tick stopped where it did. */
export type Suspension = {
  status: "sleeping" | "waiting";
  /** When a tick is needed to continue; none for a wait on a signal or batch. */
  wakes: number[];
};

const DONE = Symbol("done");

/**
 * What `run` receives as its first argument. Every method takes a **key**,
 * unique within the workflow and the same on every pass: a step whose key has
 * a stored result returns it without running again, which is how a workflow
 * resumes where it stopped. Code outside the steps runs again on every pass.
 */
export class Step {
  /** The workflow's id. */
  readonly workflowId: string;

  private readonly steps: Map<string, StepRecord>;
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  /** @internal Why the tick stopped, once a step suspended it. */
  suspension: Suspension | undefined;
  /** @internal The tick lost its hold on the workflow. */
  lost = false;
  /** The workflow was cancelled during this tick. */
  private cancelled = false;
  /** @internal The step the workflow is on, for its status. */
  current: string | null = null;

  /** @internal Built by the workflow runtime, once per tick. */
  constructor(private readonly tick: StepTick) {
    this.workflowId = tick.workflowId;
    this.steps = new Map(tick.steps.map((step) => [step.key, step]));
  }

  /**
   * Runs `fn` once and stores what it returns, as JSON; on every later pass
   * the stored value is returned without running it again. A throw is retried
   * up to `attempts`, after which the step fails and this throws a
   * `StepFailedError`, which the workflow may catch. The value comes back as
   * JSON makes it, the first time too: a `Date` becomes a string.
   *
   * At least once: a process that dies after `fn` and before its result is
   * stored runs it again. Use `ctx.idempotencyKey` for anything that must not
   * happen twice, or `attempts: 1`.
   */
  run<T>(
    key: string,
    fn: (ctx: StepContext) => T | Promise<T>,
    options: StepRunOptions = {},
  ): Promise<Awaited<T>> {
    return this.track(key, () => this.runStep(key, fn, options)) as Promise<Awaited<T>>;
  }

  /** Suspends the workflow for `duration`, without holding a process. */
  sleep(key: string, duration: Duration): Promise<void> {
    const ms = toMilliseconds(duration);
    return this.track(key, () => this.sleepStep(key, ms));
  }

  /**
   * Suspends the workflow until `Workflow.signal(id, key, payload)` and
   * returns the payload. A signal that arrives before the workflow gets here
   * is kept, and returned at once.
   */
  waitFor<T = unknown>(key: string, options: StepWaitOptions = {}): Promise<T> {
    const timeout = options.timeout === undefined ? undefined : toMilliseconds(options.timeout);
    return this.track(key, () => this.waitStep(key, timeout)) as Promise<T>;
  }

  /**
   * Dispatches `job` once per argument tuple as a batch (`Job.dispatchBatch`)
   * and suspends the workflow until every job has ended; then returns the
   * batch's status. The step is recorded and the batch dispatched in one
   * atomic write, so a crash cannot dispatch it twice.
   */
  batch<J extends Job>(
    key: string,
    job: new () => J,
    args: ReadonlyArray<Readonly<Parameters<J["run"]>>>,
    options: StepBatchOptions = {},
  ): Promise<BatchStatus> {
    return this.track(key, () => this.batchStep(key, job, args, options));
  }

  /**
   * Sets the workflow's `progress`, 0 to 1. Not a step: it writes on every
   * pass that reaches it.
   */
  async progress(value: number): Promise<void> {
    const progress = clampProgress(value);
    this.assertRunning();
    const write = this.write(undefined, () => ({ result: undefined, workflow: { progress } }));
    this.remember(write);
    await write;
  }

  /** @internal Waits for every step this tick started, however each ended. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
    }
  }

  // ---------------------------------------------------------------------

  private track<T>(key: string, body: () => Promise<T>): Promise<T> {
    if (typeof key !== "string" || key.length === 0 || key.length > 191) {
      throw new TypeError(
        `A step key is a string of 1 to 191 characters; got ${JSON.stringify(key)}.`,
      );
    }
    if (this.seen.has(key)) {
      throw new Error(
        `Two steps of workflow ${this.workflowId} use the key "${key}". Each step ` +
          `needs a key of its own, or the second would return the first one's result.`,
      );
    }
    this.seen.add(key);
    this.assertRunning();
    const promise = body();
    this.remember(promise);
    return promise;
  }

  private remember(promise: Promise<unknown>) {
    this.pending.add(promise);
    const forget = () => void this.pending.delete(promise);
    promise.then(forget, forget);
  }

  /** Once suspended, nothing else may start in this tick. */
  private assertRunning() {
    if (this.lost) throw new WorkflowLeaseLostError(this.workflowId);
    if (this.suspension) throw new WorkflowSuspended();
  }

  private suspend(status: Suspension["status"], wakeAt?: number | null): never {
    if (!this.suspension) this.suspension = { status, wakes: [] };
    if (wakeAt != null) this.suspension.wakes.push(wakeAt);
    throw new WorkflowSuspended();
  }

  /**
   * One atomic write, fenced by the tick's hold. A workflow that is being
   * cancelled takes no new work from `run`: the write is skipped and the
   * tick suspended, so `onCancel` runs next.
   */
  private async write<T>(
    key: string | undefined,
    decide: (snapshot: WorkflowSnapshot) => WorkflowChange<T>,
  ): Promise<T> {
    type Wrapped = { value: T } | typeof DONE;
    let outcome: Wrapped | undefined;
    try {
      outcome = await this.tick.store.update<Wrapped>(
        this.tick.workflowId,
        { owner: this.tick.owner, ...(key === undefined ? {} : { key }) },
        (snapshot) => {
          if (snapshot.workflow.status === "cancelling" && !this.tick.cancelling) {
            return { result: DONE };
          }
          const change = decide(snapshot);
          return { ...change, result: { value: change.result } };
        },
      );
    } catch (error) {
      if (error instanceof WorkflowLeaseLostError) this.lost = true;
      throw error;
    }
    if (outcome === undefined) {
      this.lost = true;
      throw new WorkflowLeaseLostError(this.tick.workflowId);
    }
    if (outcome === DONE) {
      this.cancelled = true;
      this.suspend("waiting");
    }
    return outcome.value;
  }

  private record(key: string, step: StepRecord | null, fields: Partial<StepRecord>): StepRecord {
    const record: StepRecord = {
      workflowId: this.tick.workflowId,
      key,
      status: "running",
      attempt: 0,
      output: null,
      error: null,
      batchId: null,
      wakeAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: 0,
      updatedAt: 0,
      ...step,
      ...fields,
    };
    this.steps.set(key, record);
    return record;
  }

  private mismatch(key: string, status: StepRunStatus, wanted: string): never {
    throw new Error(
      `Step "${key}" of workflow ${this.tick.workflowId} was recorded as a ` +
        `${status} step, and is now used as ${wanted}. A key belongs to one step; ` +
        `rename one of them.`,
    );
  }

  private async runStep<T>(
    key: string,
    fn: (ctx: StepContext) => T | Promise<T>,
    options: StepRunOptions,
  ): Promise<T> {
    const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
    const timeoutMs = options.timeout === undefined ? undefined : toMilliseconds(options.timeout);
    const cached = this.steps.get(key);
    if (cached?.status === "completed") return decode(cached.output) as T;
    if (cached?.status === "failed") throw failure(key, cached);
    if (cached?.status === "retrying" && cached.wakeAt !== null && cached.wakeAt > Date.now()) {
      this.current = key;
      this.suspend("sleeping", cached.wakeAt);
    }

    for (;;) {
      type Begin =
        | { kind: "done"; output: string | null }
        | { kind: "failed"; step: StepRecord }
        | { kind: "wait"; wakeAt: number }
        | { kind: "run"; attempt: number };
      const begin = await this.write<Begin>(key, ({ workflow, step, now }) => {
        if (step?.status === "completed") return { result: { kind: "done", output: step.output } };
        if (step?.status === "failed") return { result: { kind: "failed", step } };
        if (step && step.status !== "running" && step.status !== "retrying") {
          this.mismatch(key, step.status, "step.run");
        }
        if (step?.status === "retrying" && step.wakeAt !== null && step.wakeAt > now) {
          return { result: { kind: "wait", wakeAt: step.wakeAt } };
        }
        const attempt = (step?.attempt ?? 0) + 1;
        if (attempt > attempts) {
          const failed = this.record(key, step, {
            status: "failed",
            error:
              `Attempt ${attempt - 1} of ${attempts} never finished, most likely ` +
              `because the process running it exited.` +
              (step?.error ? ` The last error was: ${step.error}` : ""),
            finishedAt: now,
            wakeAt: null,
          });
          return { result: { kind: "failed", step: failed }, step: failed };
        }
        const running = this.record(key, step, {
          status: "running",
          attempt,
          startedAt: now,
          finishedAt: null,
          wakeAt: null,
        });
        return {
          result: { kind: "run", attempt },
          step: running,
          // `onCancel` runs while the workflow is `cancelling`, and stays so.
          workflow:
            workflow.status === "cancelling"
              ? { currentStep: key }
              : { currentStep: key, status: "running" },
        };
      });
      this.current = key;
      if (begin.kind === "done") return decode(begin.output) as T;
      if (begin.kind === "failed") throw failure(key, begin.step);
      if (begin.kind === "wait") this.suspend("sleeping", begin.wakeAt);
      const attempt = begin.attempt;

      let value: T | undefined;
      let error: unknown;
      let retry = true;
      try {
        value = await this.execute(key, fn, attempt, timeoutMs);
      } catch (thrown) {
        error = thrown;
      }
      // Cancelled while the step ran: leave it as it is; `onCancel` is next.
      if (this.cancelled) throw new WorkflowSuspended();

      let output: string | null = null;
      if (error === undefined) {
        try {
          output = encode(value, `The result of step "${key}"`);
        } catch (tooLarge) {
          error = tooLarge;
          retry = false;
        }
      }
      if (error === undefined) {
        await this.write(key, ({ step, now }) => ({
          result: undefined,
          step: this.record(key, step, {
            status: "completed",
            output,
            error: null,
            wakeAt: null,
            finishedAt: now,
          }),
        }));
        return decode(output) as T;
      }

      const message = describe(error);
      if (retry && attempt < attempts) {
        const delay = backoffFor(options.backoff ?? 0, attempt);
        const wakeAt = await this.write(key, ({ step, now }) => {
          const at = delay > 0 ? now + delay : null;
          return {
            result: at,
            step: this.record(key, step, { status: "retrying", error: message, wakeAt: at }),
          };
        });
        if (wakeAt !== null) this.suspend("sleeping", wakeAt);
        continue;
      }

      const failed = await this.write(key, ({ step, now }) => {
        const record = this.record(key, step, {
          status: "failed",
          error: message,
          wakeAt: null,
          finishedAt: now,
        });
        return { result: record, step: record };
      });
      throw failure(key, failed);
    }
  }

  /**
   * One attempt of a `step.run` function, abandoned when its timeout passes
   * or the workflow is cancelled meanwhile.
   */
  private async execute<T>(
    key: string,
    fn: (ctx: StepContext) => T | Promise<T>,
    attempt: number,
    timeoutMs: number | undefined,
  ): Promise<T> {
    const controller = new AbortController();
    const context: StepContext = {
      idempotencyKey: `${this.tick.workflowId}:${key}`,
      attempt,
      signal: controller.signal,
    };
    const work = Promise.resolve().then(() => fn(context));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const abandoned = new Promise<never>((_, reject) => {
      const abort = (reason: Error) => {
        controller.abort(reason);
        reject(reason);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => abort(new StepTimeoutError(key, timeoutMs)), timeoutMs);
      }
      if (!this.tick.cancelling) {
        poll = setInterval(() => {
          this.tick.store
            .find(this.tick.workflowId, { steps: false })
            .then((state) => {
              if (state?.workflow.status !== "cancelling" || controller.signal.aborted) return;
              this.cancelled = true;
              if (!this.suspension) this.suspension = { status: "waiting", wakes: [] };
              abort(new WorkflowCancelledError(this.tick.workflowId));
            })
            .catch(() => {});
        }, this.tick.cancelCheckMs);
        poll.unref?.();
      }
    });
    try {
      return await Promise.race([work, abandoned]);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      // An abandoned attempt may still settle; its outcome is nobody's now.
      work.catch(() => {});
      abandoned.catch(() => {});
    }
  }

  private async sleepStep(key: string, ms: number): Promise<void> {
    const cached = this.steps.get(key);
    if (cached?.status === "completed") return;
    this.current = key;
    if (cached?.status === "sleeping" && cached.wakeAt !== null && cached.wakeAt > Date.now()) {
      this.suspend("sleeping", cached.wakeAt);
    }
    const wakeAt = await this.write<number | null>(key, ({ step, now }) => {
      if (step?.status === "completed") return { result: null };
      if (step && step.status !== "sleeping") this.mismatch(key, step.status, "step.sleep");
      const at = step?.wakeAt ?? now + ms;
      if (at <= now) {
        return {
          result: null,
          step: this.record(key, step, {
            status: "completed",
            wakeAt: at,
            startedAt: step?.startedAt ?? now,
            finishedAt: now,
          }),
        };
      }
      if (step) return { result: at };
      return {
        result: at,
        step: this.record(key, null, { status: "sleeping", wakeAt: at, startedAt: now }),
        workflow: { currentStep: key },
      };
    });
    if (wakeAt !== null) this.suspend("sleeping", wakeAt);
  }

  private async waitStep(key: string, timeoutMs: number | undefined): Promise<unknown> {
    const cached = this.steps.get(key);
    if (cached?.status === "completed") return decode(cached.output);
    if (cached?.status === "timed_out") throw new WaitTimeoutError(key);
    this.current = key;
    if (
      cached?.status === "waiting" &&
      (cached.wakeAt === null || cached.wakeAt > Date.now())
    ) {
      this.suspend("waiting", cached.wakeAt);
    }
    type Outcome =
      | { kind: "value"; output: string | null }
      | { kind: "timeout" }
      | { kind: "wait"; wakeAt: number | null };
    const outcome = await this.write<Outcome>(key, ({ step, now }) => {
      if (step?.status === "completed") return { result: { kind: "value", output: step.output } };
      if (step?.status === "timed_out") return { result: { kind: "timeout" } };
      if (step?.status === "signalled") {
        return {
          result: { kind: "value", output: step.output },
          step: this.record(key, step, {
            status: "completed",
            wakeAt: null,
            startedAt: step.startedAt ?? now,
            finishedAt: now,
          }),
        };
      }
      if (step && step.status !== "waiting") this.mismatch(key, step.status, "step.waitFor");
      if (step) {
        if (step.wakeAt !== null && step.wakeAt <= now) {
          return {
            result: { kind: "timeout" },
            step: this.record(key, step, { status: "timed_out", finishedAt: now }),
          };
        }
        return { result: { kind: "wait", wakeAt: step.wakeAt } };
      }
      const wakeAt = timeoutMs === undefined ? null : now + timeoutMs;
      return {
        result: { kind: "wait", wakeAt },
        step: this.record(key, null, { status: "waiting", wakeAt, startedAt: now }),
        workflow: { currentStep: key },
      };
    });
    if (outcome.kind === "value") return decode(outcome.output);
    if (outcome.kind === "timeout") throw new WaitTimeoutError(key);
    this.suspend("waiting", outcome.wakeAt);
  }

  private async batchStep<J extends Job>(
    key: string,
    job: new () => J,
    args: ReadonlyArray<Readonly<Parameters<J["run"]>>>,
    options: StepBatchOptions,
  ): Promise<BatchStatus> {
    const allowFailures = options.allowFailures === true;
    let cached = this.steps.get(key);
    if (cached?.status === "completed") return decode(cached.output) as BatchStatus;
    if (cached?.status === "failed") throw failure(key, cached);
    if (cached && cached.status !== "batching") this.mismatch(key, cached.status, "step.batch");
    this.current = key;

    if (!cached) {
      const batch = this.tick.buildBatch(job, args, {
        name: options.name ?? `workflow:${this.tick.workflowId}:${key}`,
        allowFailures,
      });
      cached = await this.write<StepRecord>(key, ({ step, now }) => {
        if (step) return { result: step };
        const record = this.record(key, null, {
          status: "batching",
          batchId: batch.id,
          startedAt: now,
        });
        return { result: record, step: record, batch, workflow: { currentStep: key } };
      });
      this.tick.scheduled();
      if (cached.status === "completed") return decode(cached.output) as BatchStatus;
      if (cached.status === "failed") throw failure(key, cached);
    }

    const status = cached.batchId === null ? null : await this.tick.findBatch(cached.batchId);
    if (status && status.finishedAt === null) this.suspend("waiting");

    const succeeded =
      status !== null && status.cancelledAt === null && (status.failed === 0 || allowFailures);
    const output = status === null ? null : JSON.stringify(status);
    const error = succeeded
      ? null
      : status === null
        ? `The batch of step "${key}" (${cached.batchId}) no longer exists.`
        : `The batch of step "${key}" failed: ${status.failed} failed and ` +
          `${status.cancelled} cancelled of ${status.total}.`;
    const record = await this.write(key, ({ step, now }) => {
      const next = this.record(key, step, {
        status: succeeded ? "completed" : "failed",
        output,
        error,
        finishedAt: now,
      });
      return { result: next, step: next };
    });
    if (!succeeded) throw failure(key, record);
    return status!;
  }
}

/** The error a failed step throws, on the pass it failed and every later one. */
function failure(key: string, step: StepRecord): StepFailedError {
  const batch = step.batchId !== null && step.output !== null
    ? (JSON.parse(step.output) as BatchStatus)
    : undefined;
  return new StepFailedError(
    key,
    batch ? (step.error ?? `Step "${key}" failed.`) : `Step "${key}" failed: ${step.error ?? "unknown error"}`,
    batch,
  );
}

/**
 * A value as stored: JSON, or `null` for `undefined`. Refused past
 * `WORKFLOW_OUTPUT_LIMIT`, and for what JSON cannot carry.
 */
export function encode(value: unknown, what: string): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`${what} cannot be stored: JSON has no form for it.`);
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > WORKFLOW_OUTPUT_LIMIT) {
    throw new RangeError(
      `${what} is ${bytes} bytes as JSON, over the ${WORKFLOW_OUTPUT_LIMIT}-byte ` +
        `limit. Store it elsewhere and return its id.`,
    );
  }
  return json;
}

export function decode(output: string | null): unknown {
  return output === null ? undefined : JSON.parse(output);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
