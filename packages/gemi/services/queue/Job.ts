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
