import type { Job } from "./Job";

// Config key: `queue`. Derived from `QueueServiceProvider`.
export interface QueueConfig {
  /**
   * The `Job` subclasses this application dispatches, or nothing.
   *
   * ### Why "or nothing" is the point
   *
   * A dispatch that names a job the `QueueManager` has never heard of does not
   * fail — `next()` looks the name up in this list, and what is not there is
   * dropped with a line on stderr and nothing else. `Job.dispatch` has already
   * returned by then, so nothing upstream can be told. The list is therefore a
   * second spelling of `app/jobs`, kept in step by hand, and the cost of the
   * two disagreeing is paid by whatever was supposed to happen after the
   * dispatch.
   *
   * Leaving this out spells it once: the jobs are the classes under `jobsDir`.
   *
   * ### The rule, exactly
   *
   * **Declared wins, and `[]` is declared.** A `jobs` that is present is used
   * verbatim and no directory is read — that is the escape hatch for an app
   * whose jobs live somewhere this cannot walk, for one that deliberately
   * registers a subset, and for a deploy that ships no source. An empty array
   * means an app with no jobs and says so; it does not mean "find some".
   *
   * **Absent or `undefined` discovers.** `undefined` counts as absent for the
   * same reason `withDefaults` treats it that way everywhere else: a key spread
   * in from an optional value is an omission, not an instruction.
   */
  jobs?: Array<new () => Job>;

  /**
   * Where to look when `jobs` was not declared. Relative to the project root,
   * or absolute.
   *
   * Every `.ts`/`.tsx` file underneath it is imported at boot and every exported
   * class extending `Job` is registered, so this wants to be a directory of job
   * declarations rather than a directory that merely contains some. Moving the
   * jobs is what this field is for; pointing it at `app/` is not.
   */
  jobsDir?: string;

  concurrency?: number;
}

export function defineQueueConfig(config: QueueConfig): QueueConfig {
  return config;
}

export function queueConfigDefaults(): Required<QueueConfig> {
  return {
    jobs: [],
    jobsDir: "app/jobs",
    concurrency: 1,
  };
}
