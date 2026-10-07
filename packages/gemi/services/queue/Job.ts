import { app } from "../../foundation/app";
import { type BatchStatus, type JobCall, clampProgress } from "./batch";
import { type DispatchedBatch, type JobBatchOptions, QueueManager } from "./QueueManager";

/** `this.batch` inside a job dispatched with `dispatchBatch`. */
export type JobBatch = {
  /** The batch's id. */
  id: string;
  /**
   * Whether the batch has been cancelled — by `Job.cancelBatch`, or by a
   * failed job of a batch without `allowFailures`. Running jobs are not
   * stopped; a long one checks this between steps and returns early.
   */
  cancelled(): Promise<boolean>;
};

/**
 * The arguments `Job.with` takes for a job whose `run` ends with a
 * `BatchStatus` parameter: the ones before it, because the batch appends its
 * status when it enqueues the callback. Any other `run` takes its parameters
 * as they are.
 */
export type JobCallArgs<A extends any[]> = A extends [...infer Rest, infer Last]
  ? BatchStatus extends Last
    ? Rest
    : A
  : A;

export class Job {
  static name = "unset";
  worker = false;
  maxAttempts = 3;

  /**
   * Milliseconds to wait before each retry. A number is used for every retry;
   * an array gives the delay before the first retry, the second, and so on,
   * repeating its last entry. `0`, the default, retries as soon as a slot is
   * free.
   */
  backoff: number | number[] = 0;

  /**
   * Makes the job unique per key, across every process sharing the queue's
   * storage. Return a key from the dispatch arguments, or `undefined` for a
   * dispatch that should not be unique. While a job with the same key is
   * waiting or running, another dispatch is not queued: it resolves to the
   * id of the job already there. The key is freed when that job completes or
   * is dead-lettered, and at the latest after `uniqueFor`.
   *
   * The default returns `undefined`: a job is not unique unless it says so.
   */
  uniqueId(..._args: any[]): string | number | undefined | null {
    return undefined;
  }

  /**
   * How long a unique job's key is held at most, in milliseconds, so a job
   * lost with its process does not block its key forever. Default one hour.
   */
  uniqueFor = 60 * 60_000;

  /**
   * Rate limits per key, computed from the dispatch arguments: at most
   * `limit` jobs admitted per fixed `window` (milliseconds) under each `key`,
   * across every process sharing the queue's storage. A job over a limit is
   * put back until the window resets, without spending an attempt. Counted
   * when the job is admitted to run, whether it then succeeds or not.
   */
  throttle(..._args: any[]): JobThrottle | JobThrottle[] | undefined | null {
    return undefined;
  }

  /**
   * At most `limit` jobs with this `key` running at once, across every process
   * sharing the queue's storage. A job with no free slot waits, without
   * spending an attempt.
   */
  concurrency(..._args: any[]): JobConcurrency | undefined | null {
    return undefined;
  }

  /**
   * Called from `run`: puts the job back to wait `delayMs` once `run`
   * returns, without counting the attempt or calling any hook. For a provider
   * that answered "slow down". Not available to `worker` jobs.
   */
  release(delayMs = 0): void {
    this.$outcome = { kind: "release", delayMs };
  }

  /**
   * Called from `run`: fails this attempt once `run` returns, as a throw
   * would. With `retry: false` it is dead-lettered at once, whatever
   * `maxAttempts` says: for work that must not be repeated, such as a send
   * whose acceptance is uncertain. A throw after `fail(..., { retry: false })`
   * is dead-lettered too. Not available to `worker` jobs.
   */
  fail(error: unknown, options: { retry?: boolean } = {}): void {
    this.$outcome = {
      kind: "fail",
      error: error instanceof Error ? error : new Error(String(error)),
      retry: options.retry ?? true,
    };
  }

  /**
   * The batch this run belongs to, when the job was dispatched with
   * `dispatchBatch`; `undefined` otherwise. Set by the queue before `run`.
   */
  batch: JobBatch | undefined = undefined;

  /**
   * Called from `run` in a job of a batch: how far this job is, from 0 to 1,
   * for the batch's `progress`. A retry starts again from 0, and a job that
   * ends counts as 1 whatever it last said. Outside a batch it does nothing.
   * Each call is a write, so report at steps, not per item of a hot loop.
   */
  async progress(value: number): Promise<void> {
    const clamped = clampProgress(value);
    await this.$progress?.(clamped);
  }

  /** @internal Where `progress` writes; set by the queue for a job of a batch. */
  $progress: ((value: number) => Promise<void>) | undefined;

  /** @internal What `release` or `fail` asked for during this run. */
  $outcome:
    | { kind: "release"; delayMs: number }
    | { kind: "fail"; error: Error; retry: boolean }
    | undefined;

  run(..._args: any[]): Promise<any> | any {}

  onFail(_error: Error, ..._args: any[]): void {}
  onSuccess(_result: any, ..._args: any[]): void {}
  onDeadletter(_error: Error, ..._args: any[]): void {}

  /**
   * Queues the job and resolves to its id once the driver has recorded it.
   *
   * Not `async`, deliberately: a missing name and arguments JSON cannot carry
   * still throw here, on the caller's stack, as they did when this returned
   * `void`. Only the driver's answer is asynchronous. Ignoring the promise is
   * fine with the memory driver, whose enqueue cannot fail; with a driver
   * that can, an ignored rejection is an unhandled one, so await it.
   */
  static dispatch<T extends Job>(
    this: new () => T,
    ...args: Parameters<T["run"]>
  ): Promise<string> {
    if (this.name === "unset") {
      throw new Error("Cannot dispatch a job with no name");
    }

    return app(QueueManager).push(this, JSON.stringify(args));
  }

  /**
   * Queues one job per argument tuple as a batch, and resolves to the batch's
   * id and size once every job is recorded. The jobs, the batch and its
   * callbacks are recorded in one atomic write: all of them or none.
   *
   * ```ts
   * const { id } = await BuildPageJob.dispatchBatch(
   *   pages.map((page) => [page.id, importId] as const),
   *   {
   *     name: `import:${importId}`,
   *     allowFailures: true,
   *     then: ImportFinishedJob.with(importId),
   *     catch: ImportFailedJob.with(importId),
   *     finally: ImportCleanupJob.with(importId),
   *   },
   * );
   * ```
   *
   * Callbacks are jobs, enqueued exactly once, by whichever process ends the
   * job that makes them due, with the batch's status appended to their
   * arguments. Each job's own hooks run as usual. A worker job, a unique job
   * and a driver without batches are refused here, on the caller's stack.
   */
  static dispatchBatch<T extends Job>(
    this: new () => T,
    args: ReadonlyArray<Readonly<Parameters<T["run"]>>>,
    options: JobBatchOptions = {},
  ): Promise<DispatchedBatch> {
    if (this.name === "unset") {
      throw new Error("Cannot dispatch a job with no name");
    }
    return app(QueueManager).pushBatch(
      this,
      args.map((tuple) => JSON.stringify(tuple)),
      options,
    );
  }

  /**
   * A job and its arguments, without dispatching it: a batch's `then`,
   * `catch` or `finally`. When the job runs, the batch's `BatchStatus` is
   * appended to these arguments.
   */
  static with<T extends Job>(
    this: new () => T,
    ...args: JobCallArgs<Parameters<T["run"]>>
  ): JobCall {
    if (this.name === "unset") {
      throw new Error("Cannot use a job with no name as a callback");
    }
    // Thrown here, on the caller's stack, rather than when the batch is
    // recorded, for arguments JSON cannot carry.
    JSON.stringify(args);
    return { name: this.name, args };
  }

  /** A batch's status, or `null` for an id the queue has no batch under. */
  static findBatch(id: string): Promise<BatchStatus | null> {
    return app(QueueManager).findBatch(id);
  }

  /**
   * Cancels a batch that is still running, and resolves to whether it did.
   * Its waiting jobs never run; running ones finish unless they check
   * `this.batch.cancelled()`. `catch` and then `finally` run; `then` does not.
   */
  static cancelBatch(id: string): Promise<boolean> {
    return app(QueueManager).cancelBatch(id);
  }
}

export type JobThrottle = {
  /** Shared by every job that counts against the same budget. */
  key: string;
  limit: number;
  /** The window, in milliseconds. */
  window: number;
};

export type JobConcurrency = { key: string; limit: number };
