import type { Job } from "./Job";
import type { QueueDriver } from "./QueueDriver";

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

  /**
   * Where queued jobs are kept: `"memory"`, a `QueueDriver`, or a function
   * returning one.
   *
   * `"memory"` is the default and keeps them in this process — so **a restart,
   * a deploy or a crash loses every job that is waiting or running**, silently.
   * See `MemoryQueueDriver`.
   *
   * A function is called once per application, when the queue is registered.
   * Prefer it to an instance: a config module is imported by more than the
   * server (tests building several applications, build tooling, a `worker`
   * job's thread), and an instance created at import is shared by every
   * application built from that config, or opened by a process that never
   * runs a job.
   */
  driver?: "memory" | QueueDriver | (() => QueueDriver);

  /**
   * How long a claimed job is leased for, in milliseconds, before a driver
   * that shares its storage between processes may hand it to another one. The
   * manager heartbeats every job it is running at a third of this, so it bounds
   * how long a dead process's jobs stay stuck, not how long a job may run. A
   * job that blocks the event loop for longer than this can be run twice.
   */
  visibilityTimeout?: number;

  /**
   * How often, in milliseconds, to ask a driver without `subscribe` for work.
   * The memory driver wakes the queue itself and is never polled.
   */
  pollInterval?: number;
}

export function defineQueueConfig(config: QueueConfig): QueueConfig {
  return config;
}

export function queueConfigDefaults(): Required<QueueConfig> {
  return {
    jobs: [],
    jobsDir: "app/jobs",
    concurrency: 1,
    driver: "memory",
    visibilityTimeout: 5 * 60_000,
    pollInterval: 1000,
  };
}
