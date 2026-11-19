import type { EachProgress } from "./wire";
import { isShuttingDown } from "../../../server/shutdown";
import { backoffFor } from "../backoff";
import { type BatchStatus, clampProgress } from "../batch";
import type { EnqueueBatch } from "../QueueDriver";
import type { Job } from "../Job";
import { type Duration, toMilliseconds } from "./duration";
import { type ItemSourceInput, type SourceRef, sourceReader, writeSource } from "./ItemSource";
import {
  type ItemChange,
  type ItemRecord,
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

/** What a `step.each` function is handed for one item. */
export type ItemContext = StepContext & {
  /** The item's index in the list, from 0. */
  index: number;
  /** The item key: what `key(input, index)` returned, or the index. */
  key: string;
  /**
   * Ends this item as `skipped`: not an error and not retried. The reason
   * (at most 500 characters) and `data` (at most 1 KB as JSON) are kept with
   * the item and listed in the step's `problems`.
   */
  skip(reason: string, data?: unknown): never;
  /**
   * Puts this item back, to start again after `delayMs`, without using an
   * attempt (a provider answered "slow down"). The whole step holds back
   * for as long: no item starts until then.
   */
  release(delayMs: number): never;
};

/** What a `step.each` function with `chunk` is handed for one chunk of items. */
export type ChunkContext = StepContext & {
  /** The chunk's items, in the order of the inputs. */
  items: Array<{ index: number; key: string; idempotencyKey: string }>;
  /**
   * Ends the item at `position` in the chunk as `skipped`, as `ctx.skip`
   * does for one item, while the rest of the chunk succeeds. Does not throw.
   */
  skip(position: number, reason: string, data?: unknown): void;
  /** As `ItemContext.release`, for every item of the chunk. */
  release(delayMs: number): never;
};

/** A rate limit across processes, counted in the queue's lock store. */
export type EachThrottle = {
  /** Shared by everything that counts against the same budget, jobs included. */
  key: string;
  /** How many items may start per window. */
  limit: number;
  /** The window. */
  window: Duration;
};

/** Where `step.each` takes its items from: a count and a transformer, or a stored source. */
export type StepEachInput<I> =
  | {
      /**
       * How many items there are. Stored when the step first runs; a later pass
       * that computes another number goes on with the stored one.
       */
      count: number;
      /**
       * The transformer: produces the input for `index`, from 0 to `count - 1`.
       * Called once per attempt of that item, and never for the whole list at
       * once, so the list does not have to fit in memory. It must give the same
       * input for the same index for as long as the step runs (read it from a
       * table, a file or a snapshot of ids, not from a query whose order moves).
       * A throw counts as a failed attempt of the item.
       */
      item(index: number): I | Promise<I>;
      source?: never;
    }
  | {
      /**
       * A stored list (`step.source`, `ItemSource.write`): its items, in order,
       * read a window at a time.
       */
      source: SourceRef<I>;
      count?: never;
      item?: never;
    };

export type StepEachOptions<I> = StepEachInput<I> & {
  /**
   * The item's identity, from 1 to 191 characters: the last part of
   * `ctx.idempotencyKey`. Default: the index. gemi does not check that two
   * items have different keys.
   */
  key?(input: I, index: number): string | number;
  /** How many items run at once, in this process. Default 1. */
  concurrency?: number;
  /** How many attempts each item gets, counting the first. Default 3. */
  attempts?: number;
  /**
   * Milliseconds to wait before an item's retry, as `step.run`'s `backoff`.
   * Default 0. A retry that waits does not hold up the items after it.
   */
  backoff?: number | number[];
  /** How long one attempt of an item may take before it counts as failed. */
  timeout?: Duration;
  /**
   * How long one tick works through items before it hands the workflow back
   * to the queue and continues in the next tick. Default 30 seconds.
   */
  tickBudget?: Duration;
  /**
   * Whether the step sets the workflow's `progress` to the share of its
   * items that have ended. Default `true`.
   */
  progress?: boolean;
  /**
   * At most `limit` items start per `window`, across every process sharing
   * the queue's lock store: one hit per item started (retries included). An
   * item over the limit waits without using an attempt, and a wait past the
   * tick hands the workflow back until the window resets. Several limits
   * all apply. A throttle key is shared with jobs' `throttle` of that key.
   */
  throttle?: EachThrottle | EachThrottle[];
  /**
   * Runs `fn` in an ORM transaction on the queue's connection, and records
   * the item's end as the last statement of that transaction: the item's
   * database writes and its being done commit together, or not at all. A
   * crash, a lost lease, a timeout or a cancel rolls both back, and the item
   * runs again. On a workflow store that cannot (the memory driver, SQLite)
   * `fn` runs without one and the item is at least once, as without this
   * option. A throw, `ctx.skip` and `ctx.release` roll back too.
   */
  transaction?: boolean;
  /**
   * Hands `fn` up to `chunk` items at once (an array of inputs, and a
   * `ChunkContext`), so their writes go in one statement or, with
   * `transaction`, one transaction. `concurrency` then counts chunks. A
   * throw fails the attempt of every item in the chunk.
   */
  chunk?: number;
  /**
   * Fails the step (a `StepFailedError` carrying the summary) once more
   * items than this have failed, or, as `{ ratio, after }`, once the share
   * of failed items among those that ended is over `ratio` (0 to 1) and at
   * least `after` items (default 20) have ended. Items in flight are
   * stopped. Default: never; the summary reports the failures.
   */
  maxFailures?: number | { ratio: number; after?: number };
};

/** An item that failed or was skipped, as `step.each` and `Workflow.items` list it. */
export type EachProblem = {
  index: number;
  /** The item key, or `null` when its input could not be produced. */
  key: string | null;
  status: "failed" | "skipped";
  /** The last error's message, or the reason given to `ctx.skip`. */
  reason: string;
  /** The `data` given to `ctx.skip`. */
  data?: unknown;
  /** Attempts started. */
  attempt: number;
};

export type { EachProgress } from "./wire";

/** What `step.each` returns once every item has ended. */
export type EachSummary = EachProgress & {
  /** The first 100 problems, by index. `Workflow.items` lists them all. */
  problems: EachProblem[];
  /** Whether there are more problems than `problems` holds. */
  moreProblems: boolean;
};

/** A step that ran out of attempts, a batch that failed, or a `step.each` past `maxFailures`. */
export class StepFailedError extends Error {
  constructor(
    /** The step's key. */
    readonly step: string,
    message: string,
    /** The batch's final status, for a `step.batch` that failed. */
    readonly batch?: BatchStatus,
    /** Where the items stood, for a `step.each` that failed. */
    readonly summary?: EachSummary,
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
  /** Whether the queue's storage outlives this process. */
  durable?: boolean;
  /** The queue's lock store's fixed windows, for `step.each`'s `throttle`. */
  throttle?: {
    hit(name: string, limit: number, windowMs: number): Promise<{ allowed: boolean; resetInMs: number }>;
    refund(name: string): Promise<void>;
  };
};

/** Why a tick stopped where it did. */
export type Suspension = {
  /**
   * `running`: a `step.each` used up its tick and continues in the next one.
   * `paused`: the workflow was paused, and waits for `resume`.
   */
  status: "running" | "sleeping" | "waiting" | "paused";
  /** When a tick is needed to continue; none for a wait on a signal or batch. */
  wakes: number[];
};

const DONE = Symbol("done");
const PAUSED = Symbol("paused");

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
   * Works through a list of `count` items, one item at a time (or
   * `concurrency` at once), and returns a summary once every item has
   * ended. `item(index)` produces each input, so the list is never held in
   * memory, and `fn` handles it.
   *
   * ```ts
   * const summary = await step.each("rows", {
   *   count: source.count,
   *   item: (index) => readRow(source.id, index),
   *   key: (row) => row.sku,
   *   concurrency: 4,
   * }, async (row, ctx) => {
   *   if (!row.name) ctx.skip("no name");
   *   await createProduct(row, ctx.idempotencyKey);
   * });
   * // { total, done, succeeded, skipped, failed, problems, moreProblems }
   * ```
   *
   * The step keeps a cursor and a row for each item that is in flight,
   * waiting for a retry, failed or skipped; an item that succeeded leaves
   * nothing behind. A failed attempt is retried on its own (`attempts`,
   * `backoff`) while the next items go on, and an item out of attempts is
   * recorded as `failed` without failing the step. A tick works for at most
   * `tickBudget`, then the workflow continues in a new tick, so a long list
   * does not hold a queue slot and a deploy loses no more than the items in
   * flight, which run again.
   *
   * At least once, like `step.run`: an item whose process died runs again,
   * as its next attempt. Pass `ctx.idempotencyKey`
   * (`<workflow id>:<step key>:<item key>`) to anything that must not
   * happen twice.
   */
  each<I>(
    key: string,
    options: StepEachOptions<I> & { chunk?: undefined },
    fn: (input: I, ctx: ItemContext) => unknown,
  ): Promise<EachSummary>;
  each<I>(
    key: string,
    options: StepEachOptions<I> & { chunk: number },
    fn: (inputs: I[], ctx: ChunkContext) => unknown,
  ): Promise<EachSummary>;
  each<I>(
    key: string,
    options: StepEachOptions<I>,
    fn: (input: never, ctx: never) => unknown,
  ): Promise<EachSummary> {
    return this.track(key, () => this.eachStep(key, options, fn));
  }

  /**
   * Writes the list `fn` returns (an array, or any iterable or async
   * iterable, such as a parser over an uploaded file's stream) to an item
   * source, once, and returns it for `step.each({ source })`. The items are
   * written as they come, so a long list is never held in memory, and kept
   * until the workflow is pruned. A step like `step.run`: a write that fails
   * part way is written again from the start.
   *
   * ```ts
   * const rows = await step.source("rows", async () => parseRows(await Storage.read(file)));
   * const summary = await step.each("import", { source: rows, concurrency: 4 }, importRow);
   * ```
   */
  source<T>(
    key: string,
    fn: () => ItemSourceInput<T> | Promise<ItemSourceInput<T>>,
    options: Pick<StepRunOptions, "attempts" | "backoff" | "timeout"> = {},
  ): Promise<SourceRef<T>> {
    const id = `${this.workflowId}:${key}`;
    return this.run(
      key,
      async () => writeSource(this.tick.store, id, await fn(), this.workflowId),
      options,
    ) as Promise<SourceRef<T>>;
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
   * tick suspended, so `onCancel` runs next. With `start` (a write that
   * starts work), a paused workflow is suspended the same way.
   */
  private async write<T>(
    key: string | undefined,
    decide: (snapshot: WorkflowSnapshot) => WorkflowChange<T>,
    options: { items?: boolean; start?: boolean; joinTransaction?: boolean } = {},
  ): Promise<T> {
    type Wrapped = { value: T } | typeof DONE | typeof PAUSED;
    let outcome: Wrapped | undefined;
    try {
      outcome = await this.tick.store.update<Wrapped>(
        this.tick.workflowId,
        {
          owner: this.tick.owner,
          ...(key === undefined ? {} : { key }),
          ...(options.items && key !== undefined ? { items: key } : {}),
          ...(options.joinTransaction ? { joinTransaction: true } : {}),
        },
        (snapshot) => {
          if (snapshot.workflow.status === "cancelling" && !this.tick.cancelling) {
            return { result: DONE };
          }
          if (options.start && snapshot.workflow.status === "paused" && !this.tick.cancelling) {
            return { result: PAUSED };
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
    if (outcome === PAUSED) this.suspend("paused");
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
      }, { start: true });
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

  private async eachStep<I>(
    key: string,
    options: StepEachOptions<I>,
    fn: (input: never, ctx: never) => unknown,
  ): Promise<EachSummary> {
    const source = options.source;
    const count = source ? source.count : options.count;
    if (!source && typeof options.item !== "function") {
      throw new TypeError(`step.each "${key}" needs either { count, item } or { source }.`);
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EACH_COUNT) {
      throw new TypeError(
        `step.each "${key}" needs a count that is a whole number from 0 to ` +
          `${MAX_EACH_COUNT}; got ${String(count)}.`,
      );
    }
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
    const timeoutMs = options.timeout === undefined ? undefined : toMilliseconds(options.timeout);
    const budgetMs =
      options.tickBudget === undefined ? EACH_TICK_BUDGET_MS : toMilliseconds(options.tickBudget);
    const setsProgress = options.progress !== false;
    const chunked = options.chunk !== undefined;
    const chunk = chunked ? Math.max(1, Math.floor(options.chunk!)) : 1;
    const throttles = [options.throttle ?? []].flat().map((throttle) => ({
      name: `gemi:throttle:${throttle.key}`,
      limit: Math.max(0, Math.floor(throttle.limit)),
      windowMs: toMilliseconds(throttle.window),
    }));
    const exceeded = failurePolicy(options.maxFailures);
    const store = this.tick.store;
    const inTransaction =
      options.transaction === true && store.transaction
        ? <T>(body: () => Promise<T>) => store.transaction!(body)
        : undefined;
    if (options.transaction === true && !inTransaction) warnNoTransaction();
    const produce: (index: number) => I | Promise<I> = source
      ? sourceReader(store, source, Math.max(EACH_SOURCE_WINDOW, concurrency * chunk * 4))
      : options.item!;
    if (!store.listItems) {
      throw new Error(
        `This queue's workflow store does not support step.each. The memory and ` +
          `database drivers do.`,
      );
    }
    if (throttles.length > 0 && !this.tick.throttle) {
      throw new Error(`step.each "${key}" has a throttle, and this queue has no lock store.`);
    }

    const cached = this.steps.get(key);
    if (cached?.status === "completed") return summaryOf(cached.output);
    if (cached?.status === "failed") throw failure(key, cached);
    if (cached && cached.status !== "iterating") this.mismatch(key, cached.status, "step.each");
    this.current = key;
    if (this.tick.durable === false) warnNotDurable();

    type Begin =
      | { kind: "done"; output: string | null }
      | { kind: "failed"; step: StepRecord }
      | { kind: "go"; state: EachState; open: ItemRecord[] };
    const begin = await this.write<Begin>(
      key,
      ({ workflow, step, items, now }) => {
        if (step?.status === "completed") return { result: { kind: "done", output: step.output } };
        if (step?.status === "failed") return { result: { kind: "failed", step } };
        if (step && step.status !== "iterating") this.mismatch(key, step.status, "step.each");
        const state = step ? stateOf(step.output) : newState(count);
        return {
          result: { kind: "go", state, open: items },
          ...(step
            ? {}
            : {
                step: this.record(key, null, {
                  status: "iterating",
                  output: stateOutput(state),
                  startedAt: now,
                }),
              }),
          workflow:
            workflow.status === "cancelling"
              ? { currentStep: key }
              : { currentStep: key, status: "running" },
        };
      },
      { items: true, start: true },
    );
    if (begin.kind === "done") return summaryOf(begin.output);
    if (begin.kind === "failed") throw failure(key, begin.step);
    let state = begin.state;
    if (state.count !== count) warnCountChanged(this.workflowId, key, state.count, count);
    const total = state.count;
    const open = new Map(begin.open.map((item) => [item.index, item]));

    /**
     * How an attempt that finished ended, waiting to be recorded; `recorded`
     * when its own transaction already did.
     */
    type Ending = {
      index: number;
      row: ItemRecord | null;
      counter: "succeeded" | "skipped" | "failed" | null;
      recorded?: boolean;
    };
    const ended: Ending[] = [];
    /** Units (an item, or a chunk) in flight, by their first index. */
    const inFlight = new Map<number, Promise<void>>();
    /** Every item in flight, to the first index of its unit. */
    const inFlightIndex = new Map<number, number>();
    const deadline = Date.now() + budgetMs;
    /** No item starts before this: a throttle's window, or `ctx.release`. */
    let holdUntil = 0;
    let pausing = false;
    /** Why the step fails, once `maxFailures` is passed. */
    let failing: string | null = null;
    // One controller for every item of this tick: aborted when the workflow
    // is cancelled, when the step fails, and when the tick stops early.
    const tickAbort = new AbortController();
    const poll = setInterval(() => {
      store
        .find(this.workflowId, { steps: false })
        .then((found) => {
          if (found?.workflow.status === "paused") pausing = true;
          if (found?.workflow.status !== "cancelling" || tickAbort.signal.aborted) return;
          this.cancelled = true;
          if (!this.suspension) this.suspension = { status: "waiting", wakes: [] };
          tickAbort.abort(new WorkflowCancelledError(this.workflowId));
        })
        .catch(() => {});
    }, this.tick.cancelCheckMs);
    poll.unref?.();
    failing = exceeded(state);

    /** The counters after `endings`, from what is stored. */
    const advance = (stored: EachState, endings: Ending[]) => {
      const next: EachState = { ...stored };
      for (const ending of endings) if (ending.counter) next[ending.counter]++;
      return next;
    };
    const progressChange = (next: EachState) => {
      const done = next.succeeded + next.skipped + next.failed;
      return setsProgress
        ? { workflow: { progress: total === 0 ? 1 : clampProgress(done / total) } }
        : {};
    };
    /** Takes in a newer state (writes may resolve out of order: every field only grows). */
    const adopt = (next: EachState) => {
      state = {
        count: state.count,
        next: Math.max(state.next, next.next),
        succeeded: Math.max(state.succeeded, next.succeeded),
        skipped: Math.max(state.skipped, next.skipped),
        failed: Math.max(state.failed, next.failed),
      };
      if (!failing) failing = exceeded(state);
      if (failing && !tickAbort.signal.aborted) tickAbort.abort(new WorkflowSuspended());
    };

    const attempt = async (rows: ItemRecord[]): Promise<void> => {
      const keys: Array<string | null> = rows.map(() => null);
      const skips = new Map<number, { reason: string; data: unknown }>();
      const controller = new AbortController();
      const onAbort = () => controller.abort(tickAbort.signal.reason);
      tickAbort.signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const label = rows.length === 1 ? `${key}[${rows[0]!.index}]` : `${key}[${rows[0]!.index}..${rows.at(-1)!.index}]`;
      const abandoned = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
        if (timeoutMs !== undefined) {
          timer = setTimeout(
            () => controller.abort(new StepTimeoutError(label, timeoutMs)),
            timeoutMs,
          );
        }
      });
      const release = (delayMs: number): never => {
        throw new ItemReleased(Math.max(0, Math.floor(Number(delayMs) || 0)));
      };
      /** Each item's end, once `fn` returned. */
      const successes = (now: number): Ending[] =>
        rows.map((row, position) => {
          const skipped = skips.get(position);
          if (!skipped) return { index: row.index, row: null, counter: "succeeded" };
          return {
            index: row.index,
            row: skippedRow(row, keys[position]!, skipped.reason, skipped.data, now),
            counter: "skipped",
          };
        });
      let recorded: Ending[] | null = null;
      const work = (async () => {
        const inputs = await Promise.all(rows.map((row) => produce(row.index)));
        rows.forEach((row, position) => {
          keys[position] = itemKeyOf(options.key ? options.key(inputs[position]!, row.index) : row.index);
        });
        const idempotencyKey = (position: number) => `${this.workflowId}:${key}:${keys[position]}`;
        const attemptNo = Math.max(...rows.map((row) => row.attempt));
        const call = async () => {
          if (chunked) {
            const context: ChunkContext = {
              idempotencyKey: idempotencyKey(0),
              attempt: attemptNo,
              signal: controller.signal,
              items: rows.map((row, position) => ({
                index: row.index,
                key: keys[position]!,
                idempotencyKey: idempotencyKey(position),
              })),
              skip: (position, reason, data) => {
                if (!Number.isInteger(position) || position < 0 || position >= rows.length) {
                  throw new RangeError(`ctx.skip: no item at position ${position} of this chunk.`);
                }
                skips.set(position, { reason: String(reason), data });
              },
              release,
            };
            await (fn as (inputs: I[], ctx: ChunkContext) => unknown)(inputs, context);
          } else {
            const context: ItemContext = {
              idempotencyKey: idempotencyKey(0),
              attempt: attemptNo,
              signal: controller.signal,
              index: rows[0]!.index,
              key: keys[0]!,
              skip: (reason: string, data?: unknown): never => {
                throw new ItemSkipped(reason, data);
              },
              release,
            };
            await (fn as (input: I, ctx: ItemContext) => unknown)(inputs[0]!, context);
          }
        };
        if (!inTransaction) return call();
        await inTransaction(async () => {
          await call();
          // Abandoned meanwhile (a timeout, a cancel): roll back.
          if (controller.signal.aborted) throw controller.signal.reason;
          const endings = successes(Date.now());
          const next = await this.write(
            key,
            ({ step }) => {
              const change: Required<ItemChange> = { step: key, insert: [], update: [], delete: [] };
              for (const ending of endings) {
                if (ending.row === null) change.delete.push(ending.index);
                else change.update.push(ending.row);
              }
              const after = advance(step ? stateOf(step.output) : state, endings);
              return {
                result: after,
                step: this.record(key, step, { status: "iterating", output: stateOutput(after) }),
                items: change,
                ...progressChange(after),
              };
            },
            { joinTransaction: true },
          );
          recorded = endings.map((ending) => ({ ...ending, recorded: true }));
          adopt(next);
        });
      })();
      let error: unknown;
      let failed = false;
      try {
        await Promise.race([work, abandoned]);
      } catch (thrown) {
        failed = true;
        error = thrown;
      } finally {
        clearTimeout(timer);
        tickAbort.signal.removeEventListener("abort", onAbort);
        work.catch(() => {});
        abandoned.catch(() => {});
      }
      // Recorded in its own transaction: only the bookkeeping is left.
      if (recorded) {
        ended.push(...(recorded as Ending[]));
        return;
      }
      // Cancelled, stopped or lost meanwhile: the items stay as they are.
      if (tickAbort.signal.aborted || this.cancelled || this.lost) return;
      const now = Date.now();
      if (!failed) {
        ended.push(...successes(now));
        return;
      }
      if (error instanceof ItemSkipped) {
        ended.push({
          index: rows[0]!.index,
          row: skippedRow(rows[0]!, keys[0], error.reason, error.data, now),
          counter: "skipped",
        });
        return;
      }
      if (error instanceof ItemReleased) {
        holdUntil = Math.max(holdUntil, now + error.delayMs);
        rows.forEach((row, position) => {
          ended.push({
            index: row.index,
            row: {
              ...row,
              key: keys[position],
              status: "retrying",
              // Not an attempt: the next one has this one's number again.
              attempt: Math.max(0, row.attempt - 1),
              wakeAt: now + error.delayMs,
            },
            counter: null,
          });
        });
        return;
      }
      const message = clip(describe(error), 2000);
      rows.forEach((row, position) => {
        if (row.attempt < attempts) {
          const delay = backoffFor(options.backoff ?? 0, row.attempt);
          ended.push({
            index: row.index,
            row: { ...row, key: keys[position], status: "retrying", error: message, wakeAt: now + delay },
            counter: null,
          });
          return;
        }
        ended.push({
          index: row.index,
          row: { ...row, key: keys[position], status: "failed", error: message, wakeAt: null, finishedAt: now },
          counter: "failed",
        });
      });
    };

    /**
     * Counts one hit per item against every throttle, for up to `wanted`
     * items, and resolves to how many may start. The first refused hit holds
     * the step until its window resets.
     */
    const admit = async (wanted: number): Promise<number> => {
      if (throttles.length === 0 || wanted === 0) return wanted;
      const limiter = this.tick.throttle!;
      for (let admitted = 0; admitted < wanted; admitted++) {
        const counted: string[] = [];
        for (const throttle of throttles) {
          const hit = await limiter.hit(throttle.name, throttle.limit, throttle.windowMs);
          if (!hit.allowed) {
            await Promise.all(counted.map((name) => limiter.refund(name)));
            holdUntil = Math.max(holdUntil, Date.now() + Math.max(1, hit.resetInMs));
            return admitted;
          }
          counted.push(throttle.name);
        }
      }
      return wanted;
    };
    const refund = async (count: number) => {
      if (throttles.length === 0) return;
      for (let i = 0; i < count; i++) {
        for (const throttle of throttles) await this.tick.throttle!.refund(throttle.name);
      }
    };

    try {
      for (;;) {
        const now = Date.now();
        const stopping =
          now >= deadline || isShuttingDown() || this.cancelled || pausing || failing !== null;
        // What to start: items left by a tick that died, retries that are
        // due, then new items, up to `concurrency` units (items, or chunks)
        // in flight; and never more than a window of open items, so a run of
        // retries cannot grow the rows without bound.
        let rerun: ItemRecord[] = [];
        let fresh = 0;
        if (!stopping && now >= holdUntil) {
          const free = (concurrency - inFlight.size) * chunk;
          // An attempt that ended here and is not recorded yet is not a rerun.
          const ending = new Set(ended.map((end) => end.index));
          for (const row of [...open.values()].sort((a, b) => a.index - b.index)) {
            if (rerun.length >= free) break;
            if (inFlightIndex.has(row.index) || ending.has(row.index)) continue;
            if (row.status === "running" || (row.wakeAt ?? 0) <= now) rerun.push(row);
          }
          const window = concurrency * chunk + EACH_RETRY_WINDOW - open.size;
          fresh = Math.max(0, Math.min(free - rerun.length, total - state.next, window));
          const admitted = await admit(rerun.length + fresh);
          if (admitted < rerun.length) {
            rerun = rerun.slice(0, admitted);
            fresh = 0;
          } else {
            fresh = admitted - rerun.length;
          }
        }

        if (ended.length > 0 || rerun.length > 0 || fresh > 0) {
          const endings = ended.splice(0, ended.length);
          const unrecorded = endings.filter((ending) => !ending.recorded);
          const wanted = rerun.length + fresh;
          const committed = await this.write(key, ({ workflow, step, now: at }) => {
            const next = advance(step ? stateOf(step.output) : state, unrecorded);
            const change: Required<ItemChange> = { step: key, insert: [], update: [], delete: [] };
            const started: ItemRecord[] = [];
            const closed: ItemRecord[] = [];
            for (const ending of unrecorded) {
              if (ending.row === null) change.delete.push(ending.index);
              else change.update.push(ending.row);
            }
            // Paused since: record what ended, start nothing.
            const paused = workflow.status === "paused" && !this.tick.cancelling;
            for (const row of paused ? [] : rerun) {
              if (row.attempt + 1 > attempts) {
                const dead: ItemRecord = {
                  ...row,
                  status: "failed",
                  error: clip(
                    `Attempt ${row.attempt} of ${attempts} never finished, most likely ` +
                      `because the process running it exited.` +
                      (row.error ? ` The last error was: ${row.error}` : ""),
                    2000,
                  ),
                  wakeAt: null,
                  finishedAt: at,
                };
                next.failed++;
                change.update.push(dead);
                closed.push(dead);
                continue;
              }
              const running: ItemRecord = {
                ...row,
                status: "running",
                attempt: row.attempt + 1,
                wakeAt: null,
                startedAt: at,
              };
              change.update.push(running);
              started.push(running);
            }
            const starting = paused ? 0 : fresh;
            const reruns = started.length;
            for (let i = 0; i < starting; i++) {
              const running = newItem(this.workflowId, key, next.next + i, at);
              change.insert.push(running);
              started.push(running);
            }
            next.next += starting;
            return {
              result: { next, started, closed, reruns, paused },
              step: this.record(key, step, { status: "iterating", output: stateOutput(next) }),
              items: change,
              ...progressChange(next),
            };
          });
          adopt(committed.next);
          if (committed.paused) pausing = true;
          await refund(wanted - committed.started.length);
          for (const ending of endings) {
            if (ending.row?.status === "retrying") open.set(ending.index, ending.row);
            else open.delete(ending.index);
          }
          for (const row of committed.closed) open.delete(row.index);
          for (const row of committed.started) open.set(row.index, row);
          // Reruns and new items in chunks of their own: a chunk is a run of
          // new items, or of retries.
          const units = [
            ...chunksOf(committed.started.slice(0, committed.reruns), chunk),
            ...chunksOf(committed.started.slice(committed.reruns), chunk),
          ];
          for (const unit of units) {
            const first = unit[0]!.index;
            for (const row of unit) inFlightIndex.set(row.index, first);
            inFlight.set(
              first,
              attempt(unit).finally(() => {
                inFlight.delete(first);
                for (const row of unit) inFlightIndex.delete(row.index);
              }),
            );
          }
        }

        if (inFlight.size > 0) {
          await Promise.race(inFlight.values());
          continue;
        }
        if (ended.length > 0) continue;
        if (this.cancelled) throw new WorkflowSuspended();
        if (failing) break;
        if (state.next >= total && open.size === 0) break;
        if (pausing) this.suspend("paused");
        if (stopping) this.suspend("running", Date.now());
        // When something can start next: now (the slots went to items that
        // turned out to be out of attempts), when a retry is due, or when a
        // throttle or `ctx.release` lets go, whichever is latest.
        const nowAgain = Date.now();
        let earliest = Infinity;
        if (state.next < total && open.size < concurrency * chunk + EACH_RETRY_WINDOW) earliest = nowAgain;
        for (const row of open.values()) {
          if (row.status === "running") earliest = nowAgain;
          else if (row.status === "retrying") earliest = Math.min(earliest, row.wakeAt ?? 0);
        }
        const at = Math.max(earliest, holdUntil);
        if (at <= nowAgain) continue;
        const wait = at - nowAgain;
        if (wait <= Math.min(EACH_SHORT_WAIT_MS, deadline - nowAgain)) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
          continue;
        }
        this.suspend("sleeping", at);
      }
    } finally {
      clearInterval(poll);
      if (!tickAbort.signal.aborted) tickAbort.abort(new WorkflowSuspended());
    }

    const listed = await store.listItems(this.workflowId, key, {
      statuses: ["failed", "skipped"],
      limit: EACH_SUMMARY_PROBLEMS + 1,
    });
    const summary: EachSummary = {
      ...progressOf(state),
      problems: listed.slice(0, EACH_SUMMARY_PROBLEMS).map(problemOf),
      moreProblems: listed.length > EACH_SUMMARY_PROBLEMS,
    };
    const output = JSON.stringify({ $each: state, problems: summary.problems, moreProblems: summary.moreProblems });
    const reason = failing;
    const record = await this.write(key, ({ step, now }) => {
      const next = this.record(key, step, {
        status: reason ? "failed" : "completed",
        output,
        error: reason,
        finishedAt: now,
      });
      return {
        result: next,
        step: next,
        ...(setsProgress && !reason ? { workflow: { progress: 1 } } : {}),
      };
    });
    if (reason) throw failure(key, record);
    return summary;
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
      }, { start: true });
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
  if (step.output?.startsWith('{"$each"')) {
    return new StepFailedError(
      key,
      `Step "${key}" failed: ${step.error ?? "unknown error"}`,
      undefined,
      summaryOf(step.output),
    );
  }
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

/** The most items a `step.each` may have: the items table's `INTEGER` index. */
const MAX_EACH_COUNT = 2_147_483_647;
/** How long a tick works through items by default. */
const EACH_TICK_BUDGET_MS = 30_000;
/** Open items allowed beyond `concurrency`: the retries waiting their turn. */
const EACH_RETRY_WINDOW = 100;
/** A retry due sooner than this is waited for in the tick. */
const EACH_SHORT_WAIT_MS = 1_000;
/** How many items of a source `step.each` reads at a time, at least. */
const EACH_SOURCE_WINDOW = 64;
/** How many problems the summary carries. */
const EACH_SUMMARY_PROBLEMS = 100;

/** What a `step.each` keeps on its step row, beside its item rows. */
type EachState = {
  count: number;
  /** The next index nothing has started yet: the cursor. */
  next: number;
  succeeded: number;
  skipped: number;
  failed: number;
};

/** Thrown by `ctx.skip`. */
class ItemSkipped extends Error {
  constructor(
    readonly reason: string,
    readonly data: unknown,
  ) {
    super(`Skipped: ${reason}`);
    this.name = "ItemSkipped";
  }
}

/** Thrown by `ctx.release`. */
class ItemReleased extends Error {
  constructor(readonly delayMs: number) {
    super(`Released for ${delayMs}ms`);
    this.name = "ItemReleased";
  }
}

/** An item's row, ended as skipped. */
function skippedRow(
  row: ItemRecord,
  key: string | null,
  reason: string,
  data: unknown,
  now: number,
): ItemRecord {
  let output: string | null = null;
  let text = clip(String(reason));
  try {
    output = encodeSmall(data);
  } catch (tooLarge) {
    text = clip(`${text} (${describe(tooLarge)})`);
  }
  return { ...row, key, status: "skipped", error: text, output, wakeAt: null, finishedAt: now };
}

function chunksOf<T>(list: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

/** `maxFailures` as a test: why the step fails at `state`, or `null`. */
function failurePolicy(
  policy: StepEachOptions<unknown>["maxFailures"],
): (state: EachState) => string | null {
  if (policy === undefined) return () => null;
  if (typeof policy === "number") {
    const most = Math.max(0, Math.floor(policy));
    return (state) =>
      state.failed > most
        ? `${state.failed} items failed, more than maxFailures (${most}).`
        : null;
  }
  const ratio = Math.min(1, Math.max(0, policy.ratio));
  const after = Math.max(1, Math.floor(policy.after ?? 20));
  return (state) => {
    const done = state.succeeded + state.skipped + state.failed;
    if (done < after || state.failed / done <= ratio) return null;
    return (
      `${state.failed} of ${done} items failed, more than maxFailures ` +
      `allows (a ratio of ${ratio}).`
    );
  };
}

function newState(count: number): EachState {
  return { count, next: 0, succeeded: 0, skipped: 0, failed: 0 };
}

function stateOutput(state: EachState): string {
  return JSON.stringify({ $each: state });
}

function stateOf(output: string | null): EachState {
  const parsed = output === null ? null : (JSON.parse(output) as { $each?: EachState });
  if (!parsed?.$each) throw new Error("A step.each step has no state.");
  return parsed.$each;
}

/** `step.each`'s progress from its step's stored output, or `null` for another kind of step. */
export function eachProgressOf(output: string | null): EachProgress | null {
  if (output === null || !output.startsWith('{"$each"')) return null;
  try {
    return progressOf(stateOf(output));
  } catch {
    return null;
  }
}

function progressOf(state: EachState): EachProgress {
  return {
    total: state.count,
    done: state.succeeded + state.skipped + state.failed,
    succeeded: state.succeeded,
    skipped: state.skipped,
    failed: state.failed,
  };
}

function summaryOf(output: string | null): EachSummary {
  const parsed = JSON.parse(output ?? "null") as {
    $each: EachState;
    problems?: EachProblem[];
    moreProblems?: boolean;
  };
  return {
    ...progressOf(parsed.$each),
    problems: parsed.problems ?? [],
    moreProblems: parsed.moreProblems === true,
  };
}

/** An item row as `step.each` and `Workflow.items` list it. */
export function problemOf(item: ItemRecord): EachProblem {
  const problem: EachProblem = {
    index: item.index,
    key: item.key,
    status: item.status === "skipped" ? "skipped" : "failed",
    reason: clip(item.error ?? ""),
    attempt: item.attempt,
  };
  if (item.output !== null) problem.data = JSON.parse(item.output);
  return problem;
}

function newItem(workflowId: string, step: string, index: number, now: number): ItemRecord {
  return {
    workflowId,
    step,
    index,
    key: null,
    status: "running",
    attempt: 1,
    error: null,
    output: null,
    wakeAt: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function itemKeyOf(value: unknown): string {
  const key = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof key !== "string" || key.length === 0 || key.length > 191) {
    throw new TypeError(
      `An item key is a string of 1 to 191 characters, or a number; got ${JSON.stringify(value)}.`,
    );
  }
  return key;
}

function clip(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `ctx.skip`'s data as JSON, refused past 1 KB. */
function encodeSmall(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("its data has no JSON form, so it was not kept");
  if (Buffer.byteLength(json, "utf8") > 1024) {
    throw new RangeError("its data is over 1 KB as JSON, so it was not kept");
  }
  return json;
}

let warnedNotDurable = false;

/** D4: a list worked on a queue that a restart empties, in production. */
function warnNotDurable() {
  if (warnedNotDurable || process.env.NODE_ENV !== "production") return;
  warnedNotDurable = true;
  console.warn(
    `[gemi] step.each is running on a queue whose driver keeps nothing across ` +
      `restarts (the memory driver), so a deploy or a crash loses the workflow ` +
      `and the rest of its list. Use the database driver for work that must finish.`,
  );
}

/** @internal For tests. */
let warnedNoTransaction = false;

function warnNoTransaction() {
  if (warnedNoTransaction) return;
  warnedNoTransaction = true;
  console.warn(
    `[gemi] step.each with transaction: true runs its items without a transaction: ` +
      `this queue's workflow store cannot record an item in the app's transaction ` +
      `(only the database driver on Postgres or MySQL can). Items are at least once.`,
  );
}

export function resetEachWarnings() {
  warnedNoTransaction = false;
  warnedNotDurable = false;
  warnedCounts.clear();
}

const warnedCounts = new Set<string>();

function warnCountChanged(workflowId: string, key: string, stored: number, now: number) {
  const id = `${workflowId}:${key}`;
  if (warnedCounts.has(id)) return;
  warnedCounts.add(id);
  console.warn(
    `[gemi] step.each "${key}" of workflow ${workflowId} was started with a count of ` +
      `${stored} and is now given ${now}. It goes on with ${stored}: the count is ` +
      `fixed when the step first runs.`,
  );
}
