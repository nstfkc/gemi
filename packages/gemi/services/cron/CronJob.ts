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

  /**
   * Decides whether this tick happens at all. Evaluated once per tick, before
   * anything else; returning `false` skips `onTick`, `callback` and
   * `onComplete` alike.
   *
   * ### Why this is a member and not a line the job writes for itself
   *
   * A job that reports outward — mails a digest, opens a Sentry issue, pings a
   * channel — must not fire from a laptop, and the guard for that has to cover
   * the whole tick. There was nowhere to write it. gemi calls `onTick` and
   * `onComplete` *outside* `callback`, so a guard placed in a lifecycle hook
   * only stops the hook it lives in: an early `return` at the top of `callback`
   * leaves the job still announcing that it started and still announcing that
   * it finished, which for an outward-reporting job is most of the damage.
   *
   * The only construct that covered every hook was an abstract base class that
   * shadowed `callback` with the guard and renamed the real body to `run()` —
   * and that costs the app the framework's own vocabulary. A job then reads
   * `async run()` while every page of the documentation reads `async
   * callback()`, so the next person to follow the docs writes a `callback` the
   * base class never calls: no error, no output, a job that silently does
   * nothing. Forgetting *this* member fails the other way round — the job runs,
   * which is what it did before anyone asked for a gate.
   *
   * ### What it gates
   *
   * Work, not registration. A job whose gate returns `false` is still
   * scheduled, still holds its `Bun.cron` handle, and still appears in
   * `app(Scheduler).jobs` — "is it scheduled" and "will it do anything" are
   * different questions and the second one is answered per tick. That is also
   * why this is a method: a field would be read once, when the scheduler
   * constructs the job at boot, and would freeze whatever it saw then.
   *
   * A gate that throws is logged and treated as `false`. Cron work recurs, so
   * a skipped tick is recovered by the next one, while an email sent from the
   * wrong machine is not recovered at all.
   *
   * ### Composing with a base class
   *
   * Nothing here calls `super` for you. A subclass that overrides `shouldRun`
   * for its own reason silently replaces whatever its base was gating on, so
   * narrow rather than redefine:
   *
   * ```typescript
   * async shouldRun() {
   *   return (await super.shouldRun()) && this.hasSubscribers();
   * }
   * ```
   *
   * A shared base should annotate its return type as written here rather than
   * let it be inferred: a base returning a plain `boolean` narrows the
   * signature its subclasses inherit, and the `await super` above then does not
   * typecheck against it.
   */
  shouldRun(): Promise<boolean> | boolean {
    return true;
  }

  callback(): Promise<void> | void {}
  onTick(): Promise<void> | void {}
  onComplete(): Promise<void> | void {}

  static exp(expression: CronExpression) {
    return expression;
  }
}
