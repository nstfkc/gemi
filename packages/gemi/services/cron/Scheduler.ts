import type { CronJob } from "./CronJob";
import type { ScheduleConfig } from "./config";

// The handle the in-process `Bun.cron(schedule, callback)` overload returns
// (has `.stop()`). `ReturnType<typeof Bun.cron>` can't be used — it resolves to
// the module-path overload's `Promise<void>` instead.
type BunCronHandle = Bun.CronJob;

// Runs a tick inside whatever async context the framework needs, so a job body
// can resolve services exactly like a request handler can.
export type ScheduleRunner = <T>(cb: () => T | Promise<T>) => Promise<T> | T;

declare global {
  // Registered cron jobs keyed by name, kept on `globalThis` so it survives
  // `bun --hot` reloads. Re-registering a name stops the previous schedule
  // first, so a reload *updates* the job in place instead of stacking a
  // duplicate. (Bun also stops all in-process cron jobs before re-evaluating on
  // hot reload; this makes the intent explicit and covers any re-construction.)
  var __gemiCronJobs: Map<string, BunCronHandle> | undefined;
}

/**
 * One tick of one job: the gate, then the three hooks in order.
 *
 * Named and exported rather than left inline in `start()` because otherwise the
 * only way to reach it is to wait — the tightest schedule `Bun.cron` accepts is
 * once a minute, which is not a thing a test can honestly sit through. What a
 * caller gives up by calling this directly is Bun's clock; what it keeps is
 * everything the scheduler puts between the clock and the job, which is the
 * part that has behaviour.
 *
 * The three hooks each catch and log, so one throwing does not stop the next —
 * `onComplete` in particular runs whether `callback` returned or threw, closer
 * to a `finally` than to a success handler.
 */
export async function runTick(job: CronJob): Promise<void> {
  try {
    // Plain truthiness, not `!== false`. The sloppy gate an app writes is
    // `if (!isProduction) return false;`, which returns `undefined` on the path
    // that was meant to run — and between the two readings of that, the one
    // that skips a recurring tick is recoverable and the one that mails a
    // customer from a developer's laptop is not. The declared return type makes
    // that method a compile error anyway, so the type system catches it while
    // it is still being written and the runtime stays on the safe side.
    if (!(await job.shouldRun.call(job))) {
      return;
    }
  } catch (error) {
    // Fail closed, for the same reason. A gate that throws has told us nothing
    // about whether the job may run, and the framework already refuses to
    // schedule a job whose name or expression it cannot read rather than run
    // something half-declared. The throw is logged, so this is loud; the missed
    // tick comes back on the next one.
    console.error(
      `Error evaluating shouldRun for cron job ${job.name}:`,
      error,
    );
    return;
  }

  try {
    await job.onTick.call(job);
  } catch (error) {
    console.error(`Error executing cron job ${job.name}:`, error);
  }
  try {
    await job.callback.call(job);
  } catch (error) {
    console.error(`Error in cron job ${job.name}:`, error);
  }
  try {
    await job.onComplete.call(job);
  } catch (error) {
    console.error(`Error completing cron job ${job.name}:`, error);
  }
}

export class Scheduler {
  static token = "scheduler";

  private handles: BunCronHandle[] = [];
  private resolved: Array<new () => CronJob>;

  constructor(config: Required<ScheduleConfig>) {
    this.resolved = config.jobs;
  }

  /**
   * The jobs this scheduler will run, or ran — declared in the config slice or
   * discovered under `app/cron`, whichever the slice asked for.
   *
   * #323 turned an application's schedule from an array it could import into a
   * directory it cannot, and an app that had a test walking that array —
   * asserting every report has an owner, that no two share an expression — was
   * about to lose it. This is where that test goes instead, and it is the
   * better question anyway: the config slice says what was asked for, this says
   * what the scheduler took.
   *
   * It lists what `start()` iterates, not what `Bun.cron` accepted. A job with
   * no name or no expression is logged and skipped, and still appears here.
   */
  get jobs(): ReadonlyArray<new () => CronJob> {
    return this.resolved;
  }

  /**
   * Replaces the job set, for the provider to hand over what it found under
   * `app/cron` before it calls `start()`.
   *
   * The scheduler is constructed in `register()`, where reading a directory and
   * importing what is in it is not allowed to happen — that phase is
   * synchronous and resolves nothing. So it is built from whatever the slice
   * declared and corrected in `boot()`, one line before it starts. Calling this
   * after `start()` changes what `jobs` reports and nothing else; the schedules
   * are already registered.
   */
  useJobs(jobs: Array<new () => CronJob>) {
    this.resolved = jobs;
  }

  /**
   * Schedules every configured job. Called from `ScheduleServiceProvider.boot()`
   * — never from the constructor — so a job body may resolve any service the
   * container holds by the time it first ticks. That ordering is what replaced
   * the old `kernel.waitForBoot()` handshake.
   */
  start(run: ScheduleRunner = (cb) => cb()) {
    if (this.resolved.length === 0) {
      return;
    }

    const registry = (globalThis.__gemiCronJobs ??= new Map());

    // Names claimed during *this* pass, which is a different question from what
    // `registry` holds. `registry` spans hot reloads and is supposed to already
    // contain the previous reload's handle under the same name; this starts
    // empty every time and is how a name claimed twice in one schedule is told
    // apart from the same job coming back after an edit.
    const claimed = new Map<string, string>();

    for (const Job of this.resolved) {
      const job = new Job();
      if (!job.name) {
        // Named by its class, because under discovery nobody wrote this job
        // down anywhere and `JSON.stringify(job)` on a nameless one prints
        // `{}`. The overwhelmingly common cause is the second sentence: a
        // shared base class sitting in the walked directory. `abstract` is
        // erased before this code runs, so there is nothing here that could
        // tell a base class from a job — only the message can.
        console.error(
          `Cron job must have a name — ${Job.name || "an anonymous class"} ` +
            `has none, so it is not scheduled. If this is a base class that ` +
            `other jobs extend, move it out of the discovered directory: ` +
            `\`abstract\` does not survive to runtime, so a class under ` +
            `app/cron is indistinguishable from a job.`,
        );
        continue;
      }
      if (!job.cron) {
        console.error(`Cron job must have an expression. Job: ${job.name}`);
        continue;
      }
      const taken = claimed.get(job.name);
      if (taken !== undefined) {
        // Refusing the second one, rather than letting it through to the
        // `registry.get(...).stop()` below — which is what used to happen, and
        // it stopped the *first* job's schedule while leaving both classes in
        // `jobs`. That is the failure #323 exists to remove wearing a disguise:
        // a report that silently stops arriving, and a test walking `jobs` that
        // sees two healthy entries and passes.
        console.error(
          `Two cron jobs claim the name "${job.name}" — ${taken} is ` +
            `scheduled and ${Job.name || "an anonymous class"} is not. A name ` +
            `is the scheduler's key, so only one job can hold it. Rename one.`,
        );
        continue;
      }
      claimed.set(job.name, Job.name || "an anonymous class");

      // Update in place: stop any schedule previously registered under this name
      // before re-registering, so a hot reload replaces rather than duplicates.
      registry.get(job.name)?.stop();

      // Inside `run`, gate included: a `shouldRun` that resolves a service to
      // decide is the ordinary case, and evaluating it out here would leave it
      // without the application context every other line of the tick has.
      const handle = Bun.cron(job.cron, () => run(() => runTick(job)));

      registry.set(job.name, handle);
      this.handles.push(handle);
    }
  }

  stop() {
    for (const handle of this.handles) {
      handle.stop();
    }
    this.handles = [];
  }
}
