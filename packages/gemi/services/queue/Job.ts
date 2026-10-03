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
