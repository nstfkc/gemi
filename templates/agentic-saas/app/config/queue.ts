import { defineQueueConfig } from "gemi/services";

/**
 * The queue.
 *
 * `jobs` is left out on purpose, and leaving it out is what asks gemi to read
 * `app/jobs`: every `Job` subclass under there is registered at boot, so a job
 * is dispatchable by existing. `app/jobs/TestJob.ts` is registered by this file
 * saying nothing about it.
 *
 * Declare `jobs` to take that over — a present `jobs` is used verbatim and no
 * directory is read, and `jobs: []` counts as present. Do not write `jobs: []`
 * meaning "none yet"; it means "no jobs, and I mean it", and every dispatch
 * against an empty registry is then dropped.
 *
 * Either way, what the queue ended up with is `app(QueueManager).registeredJobs`.
 */
export default defineQueueConfig({
  concurrency: 1, // max jobs running at once
});
