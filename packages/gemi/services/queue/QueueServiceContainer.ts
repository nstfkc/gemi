import { log } from "console";
import { ServiceContainer } from "../ServiceContainer";
import { Job } from "./Job";
import { QueueServiceProvider } from "./QueueServiceProvider";

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
      self.onmessage = async (event) => {
      const mod = await import("${appPath}");
      try {
        const result = await mod.app.dispatchJob(event.data.jobName, event.data.args)
          self.postMessage({result});
        } catch (error) {
          self.postMessage({error});
        }
      };
    `,
    ],
    "worker.ts",
  );
  const url = URL.createObjectURL(file);
  return new Worker(url);
}

async function runInWorker(jobName: string, args: string) {
  const worker = createWorker();
  worker.postMessage({ jobName, args });
  const result = await new Promise((resolve) => {
    worker.onmessage = (e) => {
      resolve(e.data);
    };
  });
  setTimeout(() => {
    worker.terminate();
  }, 100);
  return result;
}

type JobDefinition = {
  class: string;
  args: string;
  createdAt: number;
  retries: number;
};

export class QueueServiceContainer extends ServiceContainer {
  static _name = "QueueServiceContainer";

  queue: Set<JobDefinition> = new Set();
  activeRunningJobsCount = 0;

  isRunning = false;

  jobs: Record<string, new () => Job> = {};

  constructor(public service: QueueServiceProvider) {
    super();
    this.jobs = Object.fromEntries(
      this.service.jobs.map((job) => [job.name, job]),
    );
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

    if (this.activeRunningJobsCount >= this.service.concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.next();
    }

    const jobDefinition = this.queue.values().next().value as JobDefinition;

    if (this.jobs[jobDefinition?.class]) {
      this.queue.delete(this.queue.values().next().value);

      this.run(jobDefinition);
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
    const args = JSON.parse(jobDefinition.args);

    this.activeRunningJobsCount++;
    if (jobInstance.worker) {
      const workerResult: any = await runInWorker(
        jobDefinition.class,
        jobDefinition.args,
      );

      if ("error" in workerResult) {
        jobInstance.onFail(workerResult.error, args);
        if (jobDefinition.retries >= jobInstance.maxAttempts - 1) {
          jobInstance.onDeadletter(workerResult.error);
        } else {
          this.push(Job, jobDefinition.args, jobDefinition.retries + 1);
        }
      } else {
        jobInstance.onSuccess(workerResult.result, args);
      }
    } else {
      try {
        const result = await jobInstance.run(args);
        jobInstance.onSuccess(result, args);
      } catch (err) {
        jobInstance.onFail(err, args);
        if (jobDefinition.retries >= jobInstance.maxAttempts - 1) {
          jobInstance.onDeadletter(err);
        } else {
          this.push(Job, jobDefinition.args, jobDefinition.retries + 1);
        }
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
