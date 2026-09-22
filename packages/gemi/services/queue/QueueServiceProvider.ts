import type { Application } from "../../foundation/Application";
import { ServiceProvider } from "../../support/ServiceProvider";
import { discoverJobs } from "../discovery";
import { withDefaults } from "../../support/withDefaults";
import { queueConfigDefaults, type QueueConfig } from "./config";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import { claimsInThisProcess, QueueManager } from "./QueueManager";

export class QueueServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      QueueManager,
      () =>
        new QueueManager(this.app.config.get<QueueConfig>("queue", {}), {
          application: this.app,
        }),
    );
  }

  /**
   * Fills in the job registry when the app did not declare one.
   *
   * ### Why the raw slice and not the manager's config
   *
   * The decision here is whether the app said anything, and by the time the
   * manager holds a config it can no longer tell: `withDefaults` treats an
   * absent key and an `undefined` one alike and substitutes the default `[]`,
   * which is the same value an app writes when it means "no jobs, and I mean
   * it". Reading the slice before defaults are applied is the only place the
   * difference still exists.
   *
   * So: `jobs` present, including `jobs: []`, is used verbatim and no directory
   * is read. Absent or `undefined`, the classes under `jobsDir` are.
   *
   * ### Why phase two
   *
   * Discovery imports every file it walks, which is asynchronous, and
   * `register()` is not. It also has to happen before the first dispatch rather
   * than before the first tick — there is no equivalent of the scheduler's
   * `start()` to hang it off, so the registry has to be complete by the end of
   * boot.
   */
  async boot() {
    const slice = this.app.config.get<QueueConfig>("queue", {});
    if (slice.jobs !== undefined) return;

    const { jobsDir } = withDefaults(queueConfigDefaults(), slice);
    this.app.make(QueueManager).useJobs(await discoverJobs(jobsDir));
  }

  /**
   * Stops claiming and waits for the jobs this process is running, on the way
   * out of a server told to stop. Runs after the request drain, and before the
   * database provider's, so the jobs still have their connection.
   *
   * Waits without a timeout of its own: the provider shutdown deadline is
   * what bounds it, and a job still running at that deadline is abandoned
   * with the process. With the memory driver that job is lost; with one that
   * outlives the process it is claimed again elsewhere once its lease runs
   * out. With such a driver claiming already stopped when the signal
   * arrived, so the jobs here are only the ones that were running then; the
   * memory driver kept claiming until now, so a job dispatched by a request
   * still draining ran here too.
   */
  async shutdown() {
    // Resolving the manager now would build a driver only to stop it.
    if (!this.app.resolved(QueueManager)) return;
    const queue = this.app.make(QueueManager);
    if (queue.running > 0) {
      console.log(
        `[gemi] Shutting down: waiting for ${queue.running} running queued job(s).`,
      );
    }
    const { unfinished } = await queue.drain();
    if (unfinished.length > 0) {
      console.error(
        `[gemi] Queued jobs still running at shutdown: ` +
          unfinished.map((job) => `${job.name} (${job.id})`).join(", "),
      );
    }
  }
}

/**
 * Starts claiming once the application has booted, in a production server
 * whose driver keeps jobs outside the process, rather than at its first
 * dispatch. That is the recovery half of a durable driver: the jobs a previous
 * process left behind are claimed by whichever one is up, and a replica that
 * serves no dispatch of its own would otherwise never look.
 *
 * Called by the kernel after every provider has booted, not from `boot()`
 * above: queued listeners are registered as jobs by the event provider, which
 * boots after this one, and a job claimed before its name is registered is
 * dead-lettered for it.
 *
 * Not the memory driver, which never has anything left behind. Not a console
 * command or a migration, which boot the same providers and would claim jobs
 * only to exit under them — `ROOT_DIR` is set by `Server.start()` alone. Not
 * a `worker` job's thread, which clones the application. And not development,
 * where `bun --hot` boots a fresh application on every save and each one's
 * loop would keep polling with the code it was loaded with.
 */
export function startClaimingIfServing(application: Application) {
  const slice = application.config.get<QueueConfig>("queue", {});
  const driver = slice.driver ?? "memory";
  if (driver === "memory" || driver instanceof MemoryQueueDriver) return;
  if (process.env.NODE_ENV !== "production") return;
  if (!claimsInThisProcess()) return;
  if (!application.bound(QueueManager)) return;
  application.make(QueueManager).start();
}
