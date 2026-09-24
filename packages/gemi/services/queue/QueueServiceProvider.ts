import { isMainThread } from "node:worker_threads";

import type { Application } from "../../foundation/Application";
import { ServiceProvider } from "../../support/ServiceProvider";
import { discoverJobs } from "../discovery";
import { withDefaults } from "../../support/withDefaults";
import { queueConfigDefaults, type QueueConfig } from "./config";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import {
  claimingTurnedOff,
  claimsInThisProcess,
  isQueueWorker,
  QueueManager,
} from "./QueueManager";

/**
 * How far inside the provider deadline the drain stops, so there is time left
 * to write the list of jobs it abandoned before `Application` stops waiting
 * for this provider and the process exits. A tenth of the budget, capped, so
 * that a deadline of a few milliseconds still spends most of itself waiting
 * rather than handing the whole of it to the margin.
 */
const REPORT_MARGIN_MS = 100;

const reportMargin = (timeoutMs: number) =>
  Math.min(REPORT_MARGIN_MS, Math.floor(timeoutMs / 10));

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
   * A job still running at the deadline is abandoned with the process. With
   * the memory driver that job is lost; with one that outlives the process it
   * is claimed again elsewhere once its lease runs out. With such a driver
   * claiming already stopped when the signal arrived, so the jobs here are
   * only the ones that were running then; the memory driver kept claiming
   * until now, so a job dispatched by a request still draining ran here too.
   *
   * The drain is bounded by a little less than what is left of the shared
   * provider deadline, so that this is the thing that names the jobs it gave
   * up on. Draining without a timeout of its own read better but could not
   * work: `drain()` then resolves only once every job has finished, by which
   * point nothing is unfinished and the list below is always empty — and the
   * operator who needed it got `Application`'s generic "did not finish within
   * the provider shutdown deadline" instead, which names no job at all.
   */
  async shutdown(options?: { timeoutMs: number }) {
    // Resolving the manager now would build a driver only to stop it.
    if (!this.app.resolved(QueueManager)) return;
    const queue = this.app.make(QueueManager);
    if (queue.running > 0) {
      console.log(
        `[gemi] Shutting down: waiting for ${queue.running} running queued job(s).`,
      );
    }
    const budget = options?.timeoutMs;
    const { unfinished } = await queue.drain(
      budget === undefined ? Infinity : Math.max(0, budget - reportMargin(budget)),
    );
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
 * only to exit under them — `ROOT_DIR` is set by `Server.start()` and the
 * `gemi queue:work` worker alone. Not a server started with
 * `GEMI_QUEUE_CLAIM=off`, which leaves its jobs to workers. Not
 * a `worker` job's thread, which clones the application. And not development,
 * where `bun --hot` boots a fresh application on every save: there the queue
 * starts at the first dispatch, and a reload hands a running loop over — see
 * `takeOverDevQueue`.
 */
export function startClaimingIfServing(application: Application) {
  warnAboutClaimSwitch(application);
  if (process.env.NODE_ENV !== "production") return takeOverDevQueue(application);
  if (configuresMemory(application)) return;
  if (!claimsInThisProcess()) return;
  if (!application.bound(QueueManager)) return;
  application.make(QueueManager).start();
}

function configuresMemory(application: Application) {
  const driver = application.config.get<QueueConfig>("queue", {}).driver ?? "memory";
  return driver === "memory" || driver instanceof MemoryQueueDriver;
}

/**
 * Whether the queue's jobs live only in this process, for the warning below.
 * The config says so for `"memory"` or a `MemoryQueueDriver`, but a factory
 * only says once it has run, so for one the manager is built — which is the
 * same driver `durable` and `push()` go by. A factory that throws here is
 * left to throw at the first dispatch, as it would have without the switch,
 * rather than failing the boot over a warning.
 */
function keepsJobsInProcess(application: Application) {
  if (configuresMemory(application)) return true;
  const driver = application.config.get<QueueConfig>("queue", {}).driver;
  if (typeof driver !== "function" || !application.bound(QueueManager)) return false;
  try {
    return !application.make(QueueManager).durable;
  } catch {
    return false;
  }
}

/**
 * Says so at boot when a server's `GEMI_QUEUE_CLAIM` will not do what it
 * reads as. Only in a server's main thread: a console command or a `worker`
 * job's thread shares the server's environment and claims nothing anyway.
 *
 * - `off` with the memory driver is ignored, because a memory queue's jobs
 *   exist only in the process that dispatched them. Honoured, it would leave
 *   every dispatch waiting in a `Map` that no worker can see, for good.
 * - Any value but `off` or `on` claims. `false` or `0` read as "off" and are
 *   not it, and a web process that quietly keeps claiming is the failure a
 *   deploy that set one would never notice.
 */
function warnAboutClaimSwitch(application: Application) {
  const value = process.env.GEMI_QUEUE_CLAIM;
  if (value === undefined || isQueueWorker()) return;
  if (process.env.ROOT_DIR === undefined || !isMainThread) return;
  if (claimingTurnedOff()) {
    if (!keepsJobsInProcess(application)) return;
    console.warn(
      `[gemi] GEMI_QUEUE_CLAIM=off is ignored: the memory queue driver keeps ` +
        `jobs in the process that dispatched them, so no worker could run ` +
        `them. This server runs its own jobs. Use a driver other processes ` +
        `can read, such as "database", to hand jobs to \`gemi queue:work\`.`,
    );
  } else if (value.trim().toLowerCase() !== "on") {
    console.warn(
      `[gemi] GEMI_QUEUE_CLAIM="${value}" is not "off" or "on", so this ` +
        `server claims jobs. Set it to "off" to leave them to \`gemi queue:work\`.`,
    );
  }
}

/**
 * Under `gemi dev`, stops the loop the previous application started over a
 * shared driver, and starts this application's in its place.
 *
 * A `bun --hot` reload boots a new application in the same process, and the
 * old application's loop — started lazily by a dispatch — is a live closure
 * that nothing stopped. Over the database driver it went on claiming rows
 * from the table and running them with the code from before the save, and
 * after a few saves several generations of it were doing so side by side.
 *
 * Stopped rather than drained: `stop()` claims nothing more and returns, and
 * a job the old loop is running finishes on its old code and reports as
 * usual, where waiting for it would hold up the reload behind a job. Its row
 * stays claimed until then, so the new loop cannot take it twice.
 *
 * The new loop is started only when an old one was running, which keeps the
 * rule that development claims nothing until something is dispatched, while
 * a job waiting out a retry when the file was saved still gets its retry —
 * on the new code, which is the point of the reload. A memory queue is never
 * recorded, so it is never handed over: only its own application feeds it,
 * and stopping it would drop whatever was still waiting there.
 *
 * Runs from every boot. `waitForBoot` twice on one application stops its own
 * loop and starts it again at once, which changes nothing. The `bound` guard
 * is for an application built without the queue provider, which still stops
 * the stale loop.
 */
function takeOverDevQueue(application: Application) {
  const previous = globalThis.__gemiDevQueue;
  if (!previous) return;
  globalThis.__gemiDevQueue = undefined;
  void previous.stop();
  if (application.bound(QueueManager)) application.make(QueueManager).start();
}
