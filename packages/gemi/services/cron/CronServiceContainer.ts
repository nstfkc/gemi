import { ServiceContainer } from "../ServiceContainer";
import type { CronServiceProvider } from "./CronServiceProvider";

// The handle the in-process `Bun.cron(schedule, callback)` overload returns
// (has `.stop()`). `ReturnType<typeof Bun.cron>` can't be used — it resolves to
// the module-path overload's `Promise<void>` instead.
type BunCronHandle = Bun.CronJob;

declare global {
  // Registered cron jobs keyed by name, kept on `globalThis` so it survives
  // `bun --hot` reloads. Re-registering a name stops the previous schedule
  // first, so a reload *updates* the job in place instead of stacking a
  // duplicate. (Bun also stops all in-process cron jobs before re-evaluating on
  // hot reload; this makes the intent explicit and covers any re-construction.)
  var __gemiCronJobs: Map<string, BunCronHandle> | undefined;
}

export class CronServiceContainer extends ServiceContainer {
  static _name = "CronServiceContainer";

  constructor(public service: CronServiceProvider) {
    super();

    if (this.service.jobs.length === 0) {
      return;
    }

    const registry = (globalThis.__gemiCronJobs ??= new Map());

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

      // Update in place: stop any schedule previously registered under this name
      // before re-registering, so a hot reload replaces rather than duplicates.
      registry.get(job.name)?.stop();

      const handle = Bun.cron(job.cron, () =>
        kernelRun(async () => {
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
        }),
      );

      registry.set(job.name, handle);
    }
  }
}
