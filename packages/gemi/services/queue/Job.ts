import { app } from "../../foundation/app";
import { QueueManager } from "./QueueManager";

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
}

export type JobThrottle = {
  /** Shared by every job that counts against the same budget. */
  key: string;
  limit: number;
  /** The window, in milliseconds. */
  window: number;
};

export type JobConcurrency = { key: string; limit: number };
