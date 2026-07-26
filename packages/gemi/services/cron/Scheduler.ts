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

export class Scheduler {
  static token = "scheduler";

  private handles: BunCronHandle[] = [];

  constructor(private config: Required<ScheduleConfig>) {}

  /**
   * Schedules every configured job. Called from `ScheduleServiceProvider.boot()`
   * — never from the constructor — so a job body may resolve any service the
   * container holds by the time it first ticks. That ordering is what replaced
   * the old `kernel.waitForBoot()` handshake.
   */
  start(run: ScheduleRunner = (cb) => cb()) {
    if (this.config.jobs.length === 0) {
      return;
    }

    const registry = (globalThis.__gemiCronJobs ??= new Map());

    for (const Job of this.config.jobs) {
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
        run(async () => {
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
