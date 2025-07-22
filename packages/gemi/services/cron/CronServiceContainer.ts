import Baker from "cronbake";
import { ServiceContainer } from "../ServiceContainer";
import type { CronServiceProvider } from "./CronServiceProvider";

export class CronServiceContainer extends ServiceContainer {
  static _name = "CronServiceContainer";

  constructor(public service: CronServiceProvider) {
    super();

    if (this.service.jobs.length === 0) {
      return;
    }

    const driver = Baker.create({ autoStart: true });
    const kernelRun = async <T>(cb: () => T) => {
      await this.service.kernel.waitForBoot.call(this.service.kernel);
      return await this.service.kernel.run.call(this.service.kernel, cb);
    };
    for (const Job of this.service.jobs) {
      const job = new Job();
      if (!job.name) {
        console.error(`Cron job must have a name. Job: ${JSON.stringify(job)}`);
        continue;
      }
      if (!job.cron) {
        console.error(`Cron job must have an expression. Job: ${job.name}`);
        continue;
      }
      driver.add({
        name: job.name,
        cron: job.cron,
        callback: () =>
          kernelRun(async () => {
            try {
              await job.callback.call(job);
            } catch (error) {
              console.error(`Error in cron job ${job.name}:`, error);
            }
          }),
        onComplete: () =>
          kernelRun(async () => {
            try {
              await job.onComplete.call(job);
            } catch (error) {
              console.error(`Error completing cron job ${job.name}:`, error);
            }
          }),
        onTick: () =>
          kernelRun(async () => {
            try {
              await job.onTick.call(job);
            } catch (error) {
              console.error(`Error executing cron job ${job.name}:`, error);
            }
          }),
      });
    }
    driver.bakeAll();
  }
}
