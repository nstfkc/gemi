import type { Application } from "../../foundation/Application";
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
   * fail — `run()` looks the name up in this list, and what is not there is
   * dropped with a line on stderr and nothing else. With the memory driver that
   * happens at once; with one other processes share (the database driver) the
   * job is first left for a replica that has the class, so the line comes only
   * after `unknownJobGrace` — an hour by default, of rows sitting pending with
   * no output at all. `Job.dispatch` has already
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
   * Where queued jobs are kept: `"memory"`, `"database"`, a `QueueDriver`, or
   * a function returning one.
   *
   * `"memory"` is the default and keeps them in this process — so **a restart,
   * a deploy or a crash loses every job that is waiting or running**, silently.
   * See `MemoryQueueDriver`.
   *
   * `"database"` keeps them in the `gemi_jobs` table of the default database
   * connection, which has to exist. See `DatabaseQueueDriver`.
   *
   * A function is called once per application, when the queue is first
   * resolved, with that application — so it can pick a named connection:
   * `(app) => new DatabaseQueueDriver(app.make(DatabaseManager).connection("jobs"))`.
   * Prefer it to an instance: a config module is imported by more than the
   * server (tests building several applications, build tooling, a `worker`
   * job's thread), and an instance created at import is shared by every
   * application built from that config, or opened by a process that never
   * runs a job.
   */
  driver?:
    | "memory"
    | "database"
    | QueueDriver
    | ((application: Application) => QueueDriver);

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
   *
   * It is also how long the queue waits before retrying a `claim` that
   * rejected — for every driver, `subscribe` or not, because the wake that
   * prompted the lost claim is spent and a subscribing driver has no reason to
   * send another. That delay doubles per consecutive failure, up to a minute,
   * so storage that is down is not asked this often for as long as it is down.
   */
  pollInterval?: number;

  /**
   * How long, in milliseconds, a job under a name this process has no class
   * for is left for another process before it is dead-lettered. Default one
   * hour.
   *
   * Only a driver other processes share waits: during a blue/green ramp both
   * releases claim from one table, and a job only the new release has is
   * usually one of its replicas' to run, not a dead letter. The database driver
   * does not claim such a job at all until it has been claimable for this
   * long; a driver that cannot filter by name hands it out, and the queue gives
   * it back without spending an attempt. Past the window the name is taken to
   * be gone — a job class that was deleted or renamed — and the job is
   * dead-lettered with its error, as it always was.
   *
   * Longer than a ramp, then, and than a rollback that should find the other
   * release's jobs still waiting. `Infinity` never dead-letters an unknown
   * name. The memory driver ignores this: nothing else can run its jobs, so an
   * unknown name there is dead-lettered at once.
   */
  unknownJobGrace?: number;
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
    unknownJobGrace: 60 * 60_000,
  };
}
