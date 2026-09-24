import { kernelContext } from "../../kernel/context";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { discoverCronJobs } from "../discovery";
import { scheduleConfigDefaults, type ScheduleConfig } from "./config";
import { Scheduler } from "./Scheduler";

/**
 * How far inside the provider deadline the drain stops, so there is time left
 * to name the ticks it abandoned before `Application` stops waiting for this
 * provider. The same margin as the queue's drain, for the same reason: a
 * tenth of the budget, capped, so a deadline of a few milliseconds still
 * spends most of itself waiting.
 */
const REPORT_MARGIN_MS = 100;

const reportMargin = (timeoutMs: number) => Math.min(REPORT_MARGIN_MS, Math.floor(timeoutMs / 10));

export class ScheduleServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      Scheduler,
      () =>
        new Scheduler(
          withDefaults(
            scheduleConfigDefaults(),
            this.app.config.get<ScheduleConfig>("schedule", {}),
          ),
        ),
    );
  }

  /**
   * Resolves the schedule, then starts it.
   *
   * Cron jobs are scheduled in phase two, not in `register()`: a job body is
   * free to resolve any service, and by the time `boot()` runs every provider
   * has registered. Each tick re-enters the application context so the job sees
   * the same container a request handler would.
   *
   * ### Why the raw slice and not the scheduler's config
   *
   * The decision here is whether the app said anything, and by the time the
   * scheduler holds a config it can no longer tell: `withDefaults` treats an
   * absent key and an `undefined` one alike and substitutes the default `[]`,
   * which is the same value an app writes when it means "nothing scheduled, and
   * I mean it". Reading the slice before defaults are applied is the only place
   * that difference still exists.
   *
   * So: `jobs` present, including `jobs: []`, is used verbatim and no directory
   * is read. Absent or `undefined` — which includes an app with no `schedule`
   * slice at all — the classes under `jobsDir` are, which is the case #323 is
   * about: a cron job that is written and never listed fires never, and nothing
   * downstream is waiting to notice.
   */
  async boot() {
    const scheduler = this.app.make(Scheduler);
    const slice = this.app.config.get<ScheduleConfig>("schedule", {});

    if (slice.jobs === undefined) {
      const { jobsDir } = withDefaults(scheduleConfigDefaults(), slice);
      scheduler.useJobs(await discoverCronJobs(jobsDir));
    }

    // Resolved, listed, and not started.
    //
    // `gemi run` sets this on the process it spawns. Booting the application is
    // how a console command reaches the container, and starting the schedule is
    // a side effect of that which nobody asked for: a `gemi run backfill` that
    // takes four minutes would otherwise fire the application's whole cron
    // schedule in a process no operator is watching, and `Bun.cron` handles hold
    // the loop open besides.
    //
    // Deliberately above `start` and below `useJobs`, so `app(Scheduler).jobs`
    // still answers honestly — a command that wants to fire a tick by hand can,
    // and a test asking what this application schedules gets the same answer
    // either way.
    //
    // An environment variable rather than a config field, because this is a
    // property of *this process* and not of the application: the same variable
    // is how a deploy runs one cron dyno beside several web ones, and a config
    // slice would have to know which command started it.
    if (process.env.GEMI_NO_SCHEDULE === "1") return;

    const app = this.app;
    scheduler.start((cb) => kernelContext.run(app, cb));
  }

  /**
   * Stops the schedule and waits for the ticks already running, on the way out
   * of a server told to stop.
   *
   * Stopping first is the point. Without it `Bun.cron` kept firing for the
   * whole drain window, starting ticks the process was about to exit under,
   * and a tick already running when the process exited was cut off halfway
   * through its `callback` — on a platform that recycles replicas on every
   * release, that is every release.
   *
   * The wait is bounded a little inside what is left of the shared provider
   * deadline, like the queue's, so that this is what names the ticks it gave
   * up on rather than `Application`'s generic "did not finish within the
   * provider shutdown deadline", which names no job at all.
   */
  async shutdown(options?: { timeoutMs: number }) {
    // `boot()` always resolves it; this is for an application that shuts down
    // without having booted, where building a scheduler would be pointless.
    if (!this.app.resolved(Scheduler)) return;
    const scheduler = this.app.make(Scheduler);
    if (scheduler.running > 0) {
      console.log(`[gemi] Shutting down: waiting for ${scheduler.running} running cron tick(s).`);
    }
    const budget = options?.timeoutMs;
    const { unfinished } = await scheduler.drain(
      budget === undefined ? Infinity : Math.max(0, budget - reportMargin(budget)),
    );
    if (unfinished.length > 0) {
      console.error(
        `[gemi] Cron jobs still running at shutdown: ` +
          unfinished
            .map((tick) => `${tick.name} (started ${tick.startedAt.toISOString()})`)
            .join(", "),
      );
    }
  }
}
