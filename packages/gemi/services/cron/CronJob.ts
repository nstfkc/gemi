import type { CronExpression } from "cronbake";

export class CronJob {
  name: string;
  cron: CronExpression;

  callback(): Promise<void> | void {}
  onTick(): Promise<void> | void {}
  onComplete(): Promise<void> | void {}

  static exp(expression: CronExpression) {
    return expression;
  }
}
