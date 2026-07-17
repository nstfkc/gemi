// A cron expression accepted by `Bun.cron`: a 5-field expression
// (`minute hour day-of-month month day-of-week`, interpreted in UTC) or one of
// the nicknames below. The `string & {}` member keeps arbitrary expressions
// assignable while still surfacing the nicknames in editor autocomplete.
export type CronExpression =
  | "@yearly"
  | "@annually"
  | "@monthly"
  | "@weekly"
  | "@daily"
  | "@midnight"
  | "@hourly"
  | (string & {});

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
