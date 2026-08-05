import { kernelContext } from "../../kernel/context";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
import { discoverCronJobs } from "../discovery";
import { scheduleConfigDefaults, type ScheduleConfig } from "./config";
import { Scheduler } from "./Scheduler";

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

    const app = this.app;
    scheduler.start((cb) => kernelContext.run(app, cb));
  }
}
