import { kernelContext } from "../../kernel/context";
import { ServiceProvider } from "../../support/ServiceProvider";
import { withDefaults } from "../../support/withDefaults";
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
   * Cron jobs are scheduled in phase two, not in `register()`: a job body is
   * free to resolve any service, and by the time `boot()` runs every provider
   * has registered. Each tick re-enters the application context so the job sees
   * the same container a request handler would.
   */
  boot() {
    const app = this.app;
    this.app.make(Scheduler).start((cb) => kernelContext.run(app, cb));
  }
}
