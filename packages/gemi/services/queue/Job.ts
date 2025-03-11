import { QueueServiceContainer } from "./QueueServiceContainer";

export class Job {
  static name = "unset";
  worker = false;
  maxAttempts = 3;

  run(..._args: any[]): Promise<any> | any {}

  onFail(_error: Error, _args: any): void {}
  onSuccess(_result: any, _args: any): void {}
  onDeadletter(_error: Error): void {}

  static dispatch<T extends Job>(
    this: new () => T,
    ...args: Parameters<T["run"]>
  ): void {
    if (this.name === "unset") {
      throw new Error("Cannot dispatch a job with no name");
    }

    QueueServiceContainer.use().push(this, JSON.stringify(args));
  }
}
