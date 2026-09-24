import type { Application, ShutdownReport } from "../../foundation/Application";
import { markShuttingDown, shutdownSettings, type ShutdownSettings } from "../../server/shutdown";
import { QueueManager } from "./QueueManager";

/** The part of a `Kernel` a worker drives. */
export type WorkerKernel = {
  readonly app: Application;
  waitForBoot(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<ShutdownReport>;
};

/**
 * A worker that was told to start in an application it cannot claim for. The
 * message is written for the operator reading the deploy's logs.
 */
export class QueueWorkerRefused extends Error {
  name = "QueueWorkerRefused";
}

/**
 * The process `gemi queue:work` runs: the application booted as a server boots
 * it, claiming from the queue, and no `Bun.serve`. It exists so job capacity
 * can be scaled apart from request traffic, which needs a driver both kinds of
 * process can reach; see `start` for why the memory driver is refused.
 *
 * The caller marks the process as a worker (`markQueueWorker`) before the
 * kernel registers, so every claim rule that asks `claimsInThisProcess` sees a
 * process that claims, whatever `GEMI_QUEUE_CLAIM` says.
 */
export class QueueWorker {
  private stopping: Promise<number> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private readonly settings: ShutdownSettings;

  /**
   * `settings` default to the `GEMI_SHUTDOWN_*` variables, read here rather
   * than at the signal so a bad value is warned about while the deploy is
   * being watched, as `Server.start` does.
   */
  constructor(
    private readonly kernel: WorkerKernel,
    settings: Partial<ShutdownSettings> = {},
  ) {
    this.settings = { ...shutdownSettings(), ...settings };
  }

  /**
   * Boots the application and starts claiming. Rejects with
   * `QueueWorkerRefused` when the application has no queue, or its queue uses
   * the memory driver.
   *
   * Refused rather than warned about, because a memory worker can never do
   * anything: its jobs live in a `Map` in the process that dispatched them,
   * so a worker's is always empty. Left running, it looks like a healthy
   * deploy — a process up, no errors — that runs nothing, and scaling it out
   * adds no capacity. An exit the platform reports as a crash loop is a form
   * of the mistake someone will see.
   */
  async start(): Promise<void> {
    await this.kernel.waitForBoot();
    // A signal during the boot has already drained and cleared the handle
    // below. Going on would start the loop again and arm a handle nothing
    // clears, holding open a worker that has finished shutting down.
    if (this.stopping) return;

    const application = this.kernel.app;
    // `bound`, not `make` in a try: an application built without the queue
    // provider is a configuration to name, not an unbound-token stack trace.
    if (!application.bound(QueueManager)) {
      throw new QueueWorkerRefused(
        "[gemi] `gemi queue:work` has no queue to claim from: this application " +
          "does not register QueueServiceProvider.",
      );
    }
    const queue = application.make(QueueManager);
    if (!queue.durable) {
      throw new QueueWorkerRefused(
        "[gemi] `gemi queue:work` refuses to start: the queue uses the memory " +
          "driver, which keeps each job in the process that dispatched it, so " +
          'a worker never sees one. Set `driver: "database"` (or another driver ' +
          "every process can reach) in app/config/queue.ts, or run jobs in the " +
          "server and drop the worker.",
      );
    }

    // Idempotent: a production boot with a durable driver has already started
    // it (`startClaimingIfServing`). Development has not, and a worker claims
    // in either.
    queue.start();
    // The queue's poll timer is unref'd, so that a script's queue does not
    // hold it open; here the queue is the process, and without a handle of its
    // own an idle worker would exit 0 as soon as it booted.
    this.keepAlive = setInterval(() => {}, 1 << 30);
    console.log(
      `[gemi] Queue worker started: claiming up to ${queue.config.concurrency} job(s) at a time.`,
    );
  }

  /**
   * Stops claiming, waits for the running jobs, runs every provider's
   * `shutdown()`, and resolves with the exit code: 0 when no job was left
   * running and every provider finished in time, 1 otherwise. Idempotent.
   *
   * `gemi start`'s drain, with the jobs where the requests were:
   * `isShuttingDown()` turns true, which stops a durable queue claiming;
   * running jobs get `timeoutMs` (`GEMI_SHUTDOWN_TIMEOUT`), which a server
   * spends on requests; then `Application.shutdown` gets `providerTimeoutMs`,
   * and in it the queue provider waits for whatever is still running and
   * names it. The two budgets add up as they do for a server, so a worker
   * fits the same grace period. `delayMs` is not waited: it is for a load
   * balancer, and nothing routes to a worker.
   */
  stop(settings: Partial<ShutdownSettings> = {}): Promise<number> {
    this.stopping ??= this.drain({ ...this.settings, ...settings });
    return this.stopping;
  }

  private async drain(settings: ShutdownSettings): Promise<number> {
    markShuttingDown();
    const application = this.kernel.app;
    // Resolving the manager now would build a driver only to stop it, which
    // is what a signal during the boot, before the provider resolved it, finds.
    const queue = application.resolved(QueueManager) ? application.make(QueueManager) : undefined;
    if (queue) {
      console.log(
        `[gemi] Shutting down: waiting for ${queue.running} running job(s) ` +
          `(up to ${settings.timeoutMs / 1000}s).`,
      );
      await queue.drain(settings.timeoutMs);
    }

    const report = await this.kernel.shutdown({ timeoutMs: settings.providerTimeoutMs });
    clearInterval(this.keepAlive);
    const clean =
      (queue?.running ?? 0) === 0 && report.failed.length === 0 && report.timedOut.length === 0;
    console.log(`[gemi] Shutdown ${clean ? "complete" : "finished with errors"}.`);
    return clean ? 0 : 1;
  }
}
