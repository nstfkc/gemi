import type { CronJob } from "./CronJob";

// Config key: `schedule`. Consumed by `ScheduleServiceProvider`.
export interface ScheduleConfig {
  /**
   * The `CronJob` subclasses this application runs on a schedule, or nothing.
   *
   * ### Why "or nothing" is the point
   *
   * A cron job that is written and not listed here never fires, and unlike a
   * dropped dispatch there is no caller left waiting to notice: nothing is
   * downstream of a tick that did not happen. The report is simply not sent,
   * for as long as it takes somebody to ask why they stopped seeing it. That is
   * the whole failure — the file exists, the expression is right, and the class
   * was never in the module graph.
   *
   * Leaving this out spells the schedule once: the jobs are the classes under
   * `jobsDir`.
   *
   * ### The rule, exactly
   *
   * **Declared wins, and `[]` is declared.** A `jobs` that is present is used
   * verbatim and no directory is read — the escape hatch for an app whose jobs
   * live somewhere this cannot walk, for one that runs a deliberate subset, and
   * for a deploy that ships no source. An empty array means an app with nothing
   * scheduled and says so; it does not mean "find some".
   *
   * **Absent or `undefined` discovers.** `undefined` counts as absent for the
   * same reason `withDefaults` treats it that way everywhere else: a key spread
   * in from an optional value is an omission, not an instruction.
   *
   * Either way the set the scheduler ended up with is readable afterwards, as
   * `app(Scheduler).jobs` — an app that used to import this array to assert
   * something about its own schedule asks the scheduler instead.
   */
  jobs?: Array<new () => CronJob>;

  /**
   * Where to look when `jobs` was not declared. Relative to the project root,
   * or absolute.
   *
   * Every `.ts`/`.tsx` file underneath it is imported at boot and every exported
   * class extending `CronJob` is scheduled, so this wants to be a directory of
   * cron declarations rather than a directory that merely contains some. Moving
   * the jobs is what this field is for; pointing it at `app/` is not.
   */
  jobsDir?: string;
}

export function defineScheduleConfig(config: ScheduleConfig): ScheduleConfig {
  return config;
}

export function scheduleConfigDefaults(): Required<ScheduleConfig> {
  return {
    jobs: [],
    jobsDir: "app/cron",
  };
}
