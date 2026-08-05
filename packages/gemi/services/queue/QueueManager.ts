import { Job } from "./Job";
import { queueConfigDefaults, type QueueConfig } from "./config";
import { withDefaults } from "../../support/withDefaults";

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
          result = clone.dispatchJob(event.data.jobName, event.data.args)
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

type JobDefinition = {
  class: string;
  args: string;
  createdAt: number;
  retries: number;
};

export class QueueManager {
  static token = "queue";

  queue: Set<JobDefinition> = new Set();
  activeRunningJobsCount = 0;
  isRunning = false;
  jobs: Record<string, new () => Job> = {};

  readonly config: Required<QueueConfig>;

  constructor(config: QueueConfig = {}) {
    this.config = withDefaults(queueConfigDefaults(), config);
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
      const taken = this.jobs[job.name];
      if (taken) {
        console.error(
          `Two queued jobs are named "${job.name}" — the first is registered ` +
            `and this one is not, so dispatching either would have run one of ` +
            `them. A class name is the queue's key, so only one job can hold ` +
            `it. Rename one.`,
        );
        continue;
      }
      this.jobs[job.name] = job;
    }
  }

  /**
   * What the manager was handed, discovered or declared.
   *
   * The registry is keyed by name, and a name is exactly what a dispatch
   * carries, so "is this job registered?" is a question with a silent wrong
   * answer — `next()` drops an unknown name long after the caller moved on.
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

  async next() {
    if (!this.isRunning) {
      this.isRunning = true;
    }

    if (this.activeRunningJobsCount >= this.config.concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.next();
    }

    const jobDefinition = this.queue.values().next().value as
      | JobDefinition
      | undefined;

    if (jobDefinition) {
      // Taken off the queue before anything decides what to do with it. The
      // delete used to live inside the `if` below, so a name the registry could
      // not resolve left the head in place, the `size === 0` check below was
      // never reached, and `next()` recursed on the same entry until the stack
      // gave out. An unregistered dispatch is meant to be a dropped job, not a
      // crash — and discovery makes an empty registry newly reachable (a deploy
      // that ships no source finds nothing to register), so the difference
      // stopped being theoretical.
      this.queue.delete(jobDefinition);

      if (this.jobs[jobDefinition.class]) {
        this.run(jobDefinition);
      } else {
        // The one place this is observable. A dispatch carries a name, the
        // registry is keyed by name, and a name nobody registered matches
        // nothing — which is exactly the silence #322 is about, except here it
        // has already happened and the work is gone. Saying so is all that is
        // left to do about it.
        console.error(
          `Dropped a queued job: nothing is registered under the name ` +
            `"${jobDefinition.class}". If the class exists, it was not ` +
            `discovered — check that it is under the queue slice's jobsDir ` +
            `(app/jobs by default), or list it in app/config/queue.ts.`,
        );
      }
    }

    if (this.queue.size === 0) {
      this.isRunning = false;
      return;
    }

    await this.next();
  }

  private async run(jobDefinition: JobDefinition) {
    const Job = this.jobs[jobDefinition.class];
    const jobInstance = new Job();
    const args: any[] = JSON.parse(jobDefinition.args);

    this.activeRunningJobsCount++;

    try {
      const result = await (jobInstance.worker
        ? runInWorker(jobDefinition.class, jobDefinition.args)
        : jobInstance.run(...args));

      jobInstance.onSuccess(result, ...args);
    } catch (err) {
      jobInstance.onFail(err, ...args);
      if (jobDefinition.retries >= jobInstance.maxAttempts - 1) {
        jobInstance.onDeadletter(err, ...args);
      } else {
        this.push(Job, jobDefinition.args, jobDefinition.retries + 1);
      }
    }

    this.activeRunningJobsCount--;
  }

  push(job: new () => Job, args: string, retries = 0) {
    this.queue.add({
      class: job.name,
      args,
      createdAt: Date.now(),
      retries,
    });
    if (!this.isRunning) {
      this.next();
    }
  }
}
