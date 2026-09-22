import { AsyncResource } from "node:async_hooks";
import { isMainThread } from "node:worker_threads";

import type { Application } from "../../foundation/Application";
import { DatabaseManager } from "../../database/DatabaseManager";
import { kernelContext } from "../../kernel/context";
import { isShuttingDown } from "../../server/shutdown";
import { DatabaseQueueDriver } from "./DatabaseQueueDriver";
import { Job } from "./Job";
import { queueConfigDefaults, type QueueConfig } from "./config";
import { MemoryQueueDriver } from "./MemoryQueueDriver";
import type { ClaimOptions, ClaimedJob, QueueDriver } from "./QueueDriver";
import { withDefaults } from "../../support/withDefaults";

/**
 * The thread a `worker = true` job runs in.
 *
 * The `await` on `dispatchJob` is load-bearing and its absence was a hang.
 * `postMessage` structured-clones its argument and a Promise is not cloneable,
 * so an un-awaited `dispatchJob` posted the pending promise, threw
 * `DataCloneError` inside this handler, and posted nothing at all. `runInWorker`
 * then never settled: `run` below never returned, its concurrency slot was
 * never decremented, and neither the retry path nor `onDeadletter` ever fired —
 * after `concurrency` such jobs the queue sits at its limit forever, with no
 * error anywhere. Any job whose `run` is `async` hit it, which is every job
 * that touches IO; a queued listener hits it unconditionally, because the
 * synthetic job's `run` awaits `handle`.
 *
 * The await earns two more things. A rejecting job now reaches the `catch` and
 * comes back as `{error}`, where the queue's ordinary retry-then-dead-letter
 * path can have it, instead of being lost with the promise. And `destroy()` now
 * runs after the job rather than under it, so the cloned kernel — its database
 * connections included — outlives the work it was cloned for.
 */
function createWorker() {
  const APP_DIR = process.env.APP_DIR;
  const ROOT_DIR = process.env.ROOT_DIR;

  const appPath =
    process.env.NODE_ENV === "production"
      ? `${ROOT_DIR}/dist/server/bootstrap.mjs`
      : `${APP_DIR}/bootstrap.ts`;

  const file = new File(
    [
      `
      import { app } from "${appPath}"
      self.onmessage = async (event) => {
        const clone = app.clone()
        let result = null;
        let error = null;
        try {
          result = await clone.dispatchJob(event.data.jobName, event.data.args)
        } catch (err) {
          error = err
        }
        clone.destroy()
        if(error) {
          self.postMessage({error});
        } else {
          self.postMessage({result});
        }
      };
    `,
    ],
    "worker.ts",
  );
  const url = URL.createObjectURL(file);
  return new Worker(url);
}

// TODO: terminate worker after the job is done
async function runInWorker(jobName: string, args: string) {
  const worker = createWorker();
  worker.postMessage({ jobName, args });
  return await new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const data = e.data;
      if ("error" in data) {
        reject(data.error);
      } else {
        resolve(data.result);
      }
    };
  });
}

/**
 * The async context every job runs in: the one this module was evaluated in,
 * which is boot, outside any request.
 *
 * The worker loop is long-lived and started lazily, by the first dispatch, and
 * an async function keeps the context it was started in across every `await`.
 * Started from a request, it would run every later job — dispatched by any
 * request at all — inside the first one's `RequestContext`, and with its ORM
 * transaction handle if it had one open: one user's identity leaking into
 * another's work. Captured here, where no request exists, and entered by `start()`, a job
 * sees no request at all; the Application is entered separately, per job.
 */
const bootScope = new AsyncResource("gemi.queue");

/**
 * The longest the loop waits between retries while `claim` keeps rejecting.
 *
 * Long enough that a database which is properly down is not asked once a
 * second by every worker process for as long as it stays down, short enough
 * that the queue is claiming again within a minute of it coming back.
 */
const maxClaimBackoff = 60_000;

/** What `drain` could not wait out. */
export type DrainResult = {
  /**
   * Jobs still running when the timeout elapsed. They keep running, and keep
   * their leases, until they settle or the process exits; with a driver that
   * outlives the process, an exit leaves them to be reclaimed once their lease
   * runs out. Waiting jobs are not listed — they were never taken, and are
   * wherever the driver keeps them.
   */
  unfinished: ClaimedJob[];
};

export class QueueManager {
  static token = "queue";

  jobs: Record<string, new () => Job> = {};

  readonly config: Required<QueueConfig>;
  readonly driver: QueueDriver;

  private readonly application: Application | undefined;
  /**
   * Keyed by claim, `id:attempt`, not by job id. A lease that lapses while
   * its job is still running here — heartbeats failing through a database
   * blip, or an event loop blocked past the visibility timeout — lets this
   * same process claim the job again. Both runs are then really running, so
   * both take a slot. Keyed by id alone, the second claim overwrote the first
   * and the first one's `finally` then deleted it: the live run stopped being
   * counted, drained or heartbeated, so its lease lapsed in turn and the job
   * was claimed again into a slot that was never free.
   */
  private readonly inFlight = new Map<
    string,
    { job: ClaimedJob; done: Promise<void> }
  >();
  private state: "idle" | "running" | "stopped" = "idle";
  private looping = false;
  private claiming: Promise<unknown> | undefined;
  private woken = false;
  /** Consecutive `claim` rejections; see `sleep`. Cleared by a claim that returns. */
  private claimFailures = 0;
  private resume: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `application` is entered around every job, so `app()` inside one resolves
   * to it rather than to whichever application happens to be the static
   * fallback. The provider always passes it; a manager built bare, as the unit
   * tests do, runs jobs with no application entered.
   */
  constructor(
    config: QueueConfig = {},
    options: { application?: Application } = {},
  ) {
    this.config = withDefaults(queueConfigDefaults(), config);
    this.application = options.application;
    this.driver = resolveDriver(this.config.driver, this.application);
    this.useJobs(this.config.jobs);
  }

  /**
   * Replaces the registered set, for the provider to hand over what it found
   * under `app/jobs`.
   *
   * This exists because the two phases disagree about when the answer is
   * knowable. The manager is constructed in `register()`, which is synchronous
   * and must resolve nothing; reading a directory and importing what is in it is
   * neither. So the manager is built from whatever the config slice declared —
   * nothing, when the app left `jobs` out — and the discovered set arrives in
   * `boot()`.
   *
   * The consequence worth knowing: anything that constructs an application and
   * skips phase two sees an empty registry, and every dispatch against an empty
   * registry is dropped — loudly on stderr, but after `Job.dispatch` has already
   * returned, so no caller finds out. An app that lists its jobs explicitly is
   * unaffected, because that list is already in place by the end of `register()`.
   */
  useJobs(jobs: Array<new () => Job>) {
    this.config.jobs = jobs;

    // Built one at a time rather than by `Object.fromEntries`, which resolves a
    // repeated key by keeping the last and saying nothing.
    //
    // Two classes with one name is the worst failure in this subsystem, and it
    // is worse than the dropped dispatch the rest of this file is about: the
    // registry is keyed by class name, a dispatch carries a class name, so
    // `SendEmail.dispatch(...)` on the one under `app/jobs/auth` would run the
    // body of the one under `app/jobs/billing`. Nothing is dropped and nothing
    // errors — the wrong work happens and reports success.
    //
    // Discovery is what makes it ordinary. A hand-written list forces an import
    // alias in one visible file the moment two names clash; a directory walk
    // does not, and `auth/SendEmail.ts` beside `billing/SendEmail.ts` is a
    // perfectly natural thing to write. So the first claim wins and the second
    // is refused out loud — the same rule `Scheduler.start` applies to a cron
    // name, and the reverse of the silent last-wins this replaces.
    this.jobs = {};
    for (const job of jobs) {
      this.claim(job);
    }
  }

  /**
   * Registers one more job beside whatever `useJobs` already took.
   *
   * This exists for the queued-listener adapter, which registers a synthetic
   * job per queued listener from `EventServiceProvider.boot()` — after the
   * queue's own `boot()` has filled the registry. `useJobs` cannot serve that
   * caller: it *replaces* the registry, so a second call would discard every
   * job the app wrote and leave the queue holding listeners alone. Reading
   * `registeredJobs` back, concatenating and calling `useJobs` again avoids
   * that and is still the wrong shape — it re-runs the collision check over
   * jobs that already passed it, so a duplicate the author has already been
   * told about is reported a second time on every boot.
   *
   * Same rule as `useJobs`, deliberately: the first claim on a name wins and
   * the second is refused out loud. And recorded in `config.jobs` either way,
   * so `registeredJobs` keeps reporting everything the manager was handed
   * rather than what it accepted — a refused job is visible to a test there.
   *
   * A new array rather than a `push`, because `useJobs` keeps the caller's
   * array by reference and appending to it would edit the config slice or the
   * discovered list under whoever else is holding it.
   */
  registerJob(job: new () => Job) {
    this.config.jobs = [...this.config.jobs, job];
    this.claim(job);
  }

  /**
   * Puts one job in the registry, or refuses it because the name is taken.
   *
   * The rule and the reason are in `useJobs` above; this is only the shape both
   * entry points share, so that a job arriving one at a time cannot be admitted
   * on terms the batch would have refused.
   */
  private claim(job: new () => Job) {
    if (this.jobs[job.name]) {
      console.error(
        `Two queued jobs are named "${job.name}" — the first is registered ` +
          `and this one is not, so dispatching either would have run one of ` +
          `them. A class name is the queue's key, so only one job can hold ` +
          `it. Rename one.`,
      );
      return;
    }
    this.jobs[job.name] = job;
  }

  /**
   * What the manager was handed, discovered or declared.
   *
   * The registry is keyed by name, and a name is exactly what a dispatch
   * carries, so "is this job registered?" is a question with a silent wrong
   * answer — `run()` drops an unknown name long after the caller moved on.
   * This is where a test asks it out loud.
   *
   * It reports what came in, not what the registry accepted, so a name claimed
   * twice appears twice here — deliberately, the same way `Scheduler.jobs`
   * does. A test walking this should see the collision rather than have it
   * tidied away. A copy, so that walk cannot edit the registry underneath it.
   */
  get registeredJobs(): ReadonlyArray<new () => Job> {
    return [...this.config.jobs];
  }

  dispatchJob(jobName: string, args: string) {
    if (this.jobs[jobName]) {
      const job = new this.jobs[jobName]();
      return job.run(JSON.parse(args));
    }
  }

  /**
   * Queues a job and resolves to its id once the driver has recorded it, then
   * makes sure the worker loop is running — unless `drain` stopped it, in which
   * case the job waits in the driver for whichever process claims next. With
   * the memory driver that is nobody; see `drain`. A durable driver's job also
   * waits there when this process is not a server.
   */
  push(job: new () => Job, args: string): Promise<string> {
    const id = this.driver.enqueue({ name: job.name, args });
    // A driver that outlives the process is shared with every other one, so
    // a script or console command that dispatches would otherwise claim up to
    // `concurrency` of the table's jobs — other replicas' included — and exit
    // under them, costing each an attempt and a lease's wait. There the job
    // waits in the driver for a server. A manager built by hand, with no
    // application, is its caller's to run and keeps starting.
    if (this.state === "idle" && (!this.durable || this.mayClaimHere())) {
      this.start();
    }
    // A driver without `subscribe` is only polled, so without this a job
    // dispatched here would wait up to `pollInterval` in a queue with room.
    // A spurious wake just claims nothing; a rejection is the caller's.
    if (!this.driver.subscribe) {
      id.then(
        () => this.state === "running" && this.wake(),
        () => {},
      );
    }
    return id;
  }

  /**
   * Starts claiming. Idempotent, and called by the first `push`, so an app
   * does not need to; it is public for a process that should run jobs it
   * never dispatched — ones a driver kept across a restart — and for resuming
   * after `drain`.
   */
  start() {
    if (this.state === "running") return;
    this.state = "running";
    this.unsubscribe = this.driver.subscribe?.(() => this.wake());
    // A loop a `drain` has not yet seen off picks the new state up itself;
    // starting a second would claim twice per wake.
    if (this.looping) return this.wake();
    bootScope.runInAsyncScope(() => void this.loop());
  }

  /**
   * Stops claiming, waits up to `timeoutMs` for the jobs already running, and
   * reports the ones that did not finish.
   *
   * Nothing is cancelled — a job has no way to be told — so an unfinished job
   * keeps running after this resolves. What happens to it then is the
   * driver's: the memory driver loses it with the process, along with every
   * job still waiting; one that outlives the process lets another claim it
   * once the lease runs out.
   *
   * A later `push` records its job but does not restart the loop. `start()`
   * does.
   */
  async drain(timeoutMs = Infinity): Promise<DrainResult> {
    this.state = "stopped";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.wake();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      if (timeoutMs !== Infinity) timer = setTimeout(resolve, timeoutMs);
    });
    // The claim in progress first, because what it returns is run: those jobs
    // are leased to this process already, and handing them back would cost
    // each of them an attempt it never made.
    const settled = (async () => {
      await this.claiming?.catch(() => {});
      await Promise.allSettled([...this.inFlight.values()].map((e) => e.done));
    })();
    await Promise.race([settled, deadline]);
    clearTimeout(timer);

    return {
      unfinished: [...this.inFlight.values()].map((e) => ({ ...e.job })),
    };
  }

  /** `drain(0)`: stop claiming, and report what is running without waiting. */
  stop(): Promise<DrainResult> {
    return this.drain(0);
  }

  /** How many jobs this process is running right now. */
  get running(): number {
    return this.inFlight.size;
  }

  /**
   * Claims while there is room, runs what it claims, and otherwise sleeps
   * until something changes: a job finishing frees a slot, or the driver's
   * `subscribe` says there is work. A driver without `subscribe` is polled
   * every `pollInterval` instead. This replaces a one-second timer that
   * spun while the queue was full.
   *
   * `woken` records a wake that arrived while a claim was in flight, when
   * there was nothing yet to resume; without it that job would wait for the
   * next unrelated wake.
   */
  private async loop() {
    this.looping = true;
    try {
      await this.claimWhileRunning();
    } finally {
      this.looping = false;
    }
  }

  private async claimWhileRunning() {
    while (this.state === "running") {
      // Once the server has been told to stop, a driver that outlives the
      // process gets nothing new taken from it: a job claimed now would likely
      // be cut off by the exit, and cost an attempt and a lease's wait, when
      // another replica can run it instead. The memory driver keeps claiming
      // until the provider's `drain()` stops it, because nobody else can run
      // its jobs — one waiting at the signal, or dispatched by a request
      // still draining, is run here or not at all.
      const room = this.durable && isShuttingDown()
        ? 0
        : this.config.concurrency - this.inFlight.size;

      if (room > 0) {
        this.woken = false;
        const claim = this.driver.claim(room, this.lease());
        this.claiming = claim;
        let claimed: ClaimedJob[] = [];
        try {
          claimed = await claim;
          this.claimFailures = 0;
        } catch (error) {
          this.claimFailures++;
          console.error(
            `The queue could not claim jobs from its driver; it will try ` +
              `again in ${this.retryDelay()}ms.`,
            error,
          );
        } finally {
          this.claiming = undefined;
        }
        for (const job of claimed) this.execute(job);

        // A full batch may have left more behind; the next pass either claims
        // it or, with no room left, sleeps until a slot frees.
        if (claimed.length === room) continue;
        if (this.woken && this.inFlight.size < this.config.concurrency) {
          continue;
        }
      }

      await this.sleep();
    }
  }

  /**
   * Waits for the next thing worth waking for: a slot freeing, a `subscribe`
   * driver saying there is work, or the poll timer a driver without
   * `subscribe` gets.
   *
   * A claim that rejected arms a timer whatever the driver does, and that is
   * the whole reason this is not just the `subscribe` test. The wake that
   * prompted the lost claim has already been consumed, so a driver that only
   * speaks up on an enqueue — LISTEN/NOTIFY, say — has nothing left to
   * announce: an idle worker whose one claim died on a connection reset would
   * sit there, with every job already waiting, until some unrelated process
   * enqueued again. On a busy worker an in-flight job's `wake` covers it; an
   * idle one has nothing to be rescued by.
   *
   * The delay doubles per consecutive failure so that storage which is
   * properly down is not asked once a `pollInterval` for as long as it stays
   * down, and the first claim that returns clears the count.
   */
  private sleep() {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const delay = this.claimFailures > 0
        ? this.retryDelay()
        : this.driver.subscribe
          ? undefined
          : this.config.pollInterval;
      if (delay !== undefined) {
        // Unref'd: a polling queue alone should not hold the process open.
        timer = setTimeout(() => this.wake(), delay);
        timer.unref?.();
      }
      this.resume = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** `pollInterval`, doubled once per consecutive claim failure, capped. */
  private retryDelay() {
    const doublings = Math.min(Math.max(0, this.claimFailures - 1), 30);
    return Math.min(this.config.pollInterval * 2 ** doublings, maxClaimBackoff);
  }

  private wake() {
    this.woken = true;
    const resume = this.resume;
    this.resume = undefined;
    resume?.();
  }

  /** Whether the driver keeps jobs past this process: anything but memory. */
  private get durable() {
    return !(this.driver instanceof MemoryQueueDriver);
  }

  /** See `claimsInThisProcess`. A manager built by hand always may. */
  private mayClaimHere() {
    return !this.application || claimsInThisProcess();
  }

  private lease(): ClaimOptions {
    return { visibilityTimeoutMs: this.config.visibilityTimeout };
  }

  private execute(claimed: ClaimedJob) {
    const key = `${claimed.id}:${claimed.attempt}`;
    const attempt = () => this.run(claimed);
    const done = (
      this.application
        ? kernelContext.run(this.application, attempt)
        : attempt()
    )
      .catch((error) => {
        // Only the driver's own reports reach here. The claim was not ended,
        // so its lease runs out and the job is claimed again.
        console.error(
          `The queue could not record the outcome of ${claimed.name}.`,
          error,
        );
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.wake();
      });
    this.inFlight.set(key, { job: claimed, done });
    this.heartbeat();
  }

  /**
   * Keeps every running job's lease alive, at a third of the visibility
   * timeout so one late tick does not lose it. Stops itself once nothing is
   * running, and is unref'd, like the poll.
   */
  private heartbeat() {
    const driver = this.driver;
    if (!driver.heartbeat || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(
      () => {
        if (this.inFlight.size === 0) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
          return;
        }
        const jobs = [...this.inFlight.values()].map((e) => e.job);
        driver.heartbeat!(jobs, this.lease()).catch((error) => {
          console.error(`The queue could not extend its job leases.`, error);
        });
      },
      Math.max(1, Math.floor(this.config.visibilityTimeout / 3)),
    );
    this.heartbeatTimer.unref?.();
  }

  /**
   * One attempt at one claimed job, ending the claim either way.
   *
   * `onSuccess` is inside the `try`, as it always was, so a throw from it is a
   * failed attempt and is retried. `onFail` and `onDeadletter` are not: a
   * throw from either is logged and the claim still ends, where it used to
   * escape the queue with the job's slot still counted as taken.
   */
  private async run(claimed: ClaimedJob) {
    const Job = this.jobs[claimed.name];

    if (!Job) {
      // The one place this is observable. A dispatch carries a name, the
      // registry is keyed by name, and a name nobody registered matches
      // nothing — which is exactly the silence #322 is about, except here it
      // has already happened and the work is gone. Saying so is all that is
      // left to do about it. Dead-lettered, which for the memory driver is the
      // drop it always was and for a durable one leaves a record to find.
      console.error(
        `Dropped a queued job: nothing is registered under the name ` +
          `"${claimed.name}". If the class exists, it was not ` +
          `discovered — check that it is under the queue slice's jobsDir ` +
          `(app/jobs by default), or list it in app/config/queue.ts.`,
      );
      await this.driver.fail(claimed, {
        error: `No job is registered under the name "${claimed.name}".`,
        retryInMs: null,
      });
      return;
    }

    let job: InstanceType<typeof Job>;
    try {
      job = new Job();
    } catch (error) {
      // A constructor or a class field that throws — `private mailer =
      // app(Mailer)` with nothing bound, say. Every other failure in here is
      // reported against the instance, and this one has no instance to report
      // against, which is exactly why it has to be caught here rather than
      // left to the generic path: that path never ends the claim, so the lease
      // lapses, the job is claimed again, and the constructor throws again,
      // once per visibility timeout, forever. The `maxAttempts` guard below
      // would normally stop that, and it cannot — answering "how many attempts
      // does this job get?" needs the instance that cannot be built. So it is
      // dead-lettered unrun, like a job whose arguments are not JSON: no
      // attempt of it can ever do anything but this.
      console.error(
        `Dropped a queued ${claimed.name}: it could not be constructed.`,
        error,
      );
      await this.driver.fail(claimed, {
        error: `The job could not be constructed: ${String(error)}`,
        retryInMs: null,
      });
      return;
    }

    let args: any[];
    try {
      args = JSON.parse(claimed.args);
    } catch (error) {
      // Not something `Job.dispatch` writes, so a driver changed it. Left
      // alone, the claim would never end and the job would be reclaimed,
      // unparseable, forever.
      console.error(
        `Dropped a queued ${claimed.name}: its arguments are not JSON.`,
        error,
      );
      await this.driver.fail(claimed, {
        error: `The arguments are not JSON: ${String(error)}`,
        retryInMs: null,
      });
      return;
    }

    // Claimed past its last attempt: an earlier claim used that attempt up and
    // never reported, which is what a process exiting mid-run looks like from
    // here. Running it again would exceed `maxAttempts`, so it is dead-lettered
    // unrun. `Math.max` keeps a `maxAttempts` below one meaning what it always
    // did — one attempt.
    if (claimed.attempt > Math.max(1, job.maxAttempts)) {
      const error = new Error(
        `${claimed.name} was claimed for attempt ${claimed.attempt} of ` +
          `${job.maxAttempts}: an earlier attempt never finished, most likely ` +
          `because the process running it exited. Dead-lettered without ` +
          `running it again.`,
      );
      hook(`${claimed.name}.onDeadletter`, () =>
        job.onDeadletter(error, ...args),
      );
      await this.driver.fail(claimed, {
        error: error.message,
        retryInMs: null,
      });
      return;
    }

    try {
      const result = await (job.worker
        ? runInWorker(claimed.name, claimed.args)
        : job.run(...args));

      job.onSuccess(result, ...args);
    } catch (err) {
      const error = err as Error;
      const recorded = String(error?.stack ?? error);
      hook(`${claimed.name}.onFail`, () => job.onFail(error, ...args));

      if (claimed.attempt >= job.maxAttempts) {
        hook(`${claimed.name}.onDeadletter`, () =>
          job.onDeadletter(error, ...args),
        );
        await this.driver.fail(claimed, { error: recorded, retryInMs: null });
      } else {
        await this.driver.fail(claimed, {
          error: recorded,
          retryInMs: backoffFor(job.backoff, claimed.attempt),
        });
      }
      return;
    }

    await this.driver.complete(claimed);
  }
}

function hook(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error(`${name} threw; the job's claim was ended anyway.`, error);
  }
}

/**
 * The delay before the retry that follows attempt `attempt`: the number
 * itself, or the array's entry for that retry with its last entry repeated.
 */
/**
 * Whether this process is a server's main thread, the only kind that should
 * claim from a driver shared with other processes. `ROOT_DIR` is set only by
 * a starting server, so a console command, a seed
 * or a migration — which boot the same providers — is not one, and neither is
 * a `worker` job's thread, which clones the application and exits after it.
 */
export function claimsInThisProcess() {
  return process.env.ROOT_DIR !== undefined && isMainThread;
}

export function backoffFor(backoff: number | number[], attempt: number) {
  const delay = Array.isArray(backoff)
    ? backoff[Math.min(attempt, backoff.length) - 1]
    : backoff;
  return Math.max(0, delay ?? 0);
}

function resolveDriver(
  driver: Required<QueueConfig>["driver"],
  application: Application | undefined,
): QueueDriver {
  if (driver === "memory") return new MemoryQueueDriver();
  if (driver === "database" || typeof driver === "function") {
    // Only a manager built by hand has no application. A factory that takes
    // one would otherwise fail on `undefined` with a TypeError that names
    // neither the queue nor what is missing.
    if (!application && (driver === "database" || driver.length > 0)) {
      throw new Error(
        `The queue driver needs the application it belongs to, and this ` +
          `QueueManager was built without one. Pass { application }.`,
      );
    }
    if (driver === "database") {
      return new DatabaseQueueDriver(application!.make(DatabaseManager));
    }
    return driver(application!);
  }
  if (typeof driver === "string") {
    throw new Error(
      `Unknown queue driver "${driver}". The queue slice's driver is ` +
        `"memory", "database", a QueueDriver, or a function returning one.`,
    );
  }
  return driver;
}
