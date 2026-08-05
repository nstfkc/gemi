import { Job } from "gemi/services";

/**
 * A `Job` subclass, registered by being here.
 *
 * Nothing lists this file. Every class under `app/jobs` that extends `Job` is
 * discovered when the kernel boots, which is what keeps a dispatch from being
 * dropped: the queue resolves a job by name, and a name it was never told about
 * is dropped with a line on stderr, long after `dispatch` returned.
 *
 * Dispatch it from anywhere with `TestJob.dispatch({ message: "hello" })` — the
 * call is typed against `run`.
 *
 * `static name` is not decoration. The queue is keyed by it, and a production
 * build minifies the code that dispatches — renaming the class, and with it the
 * implicit `.name` the queue would otherwise use. Discovery reads this file
 * from source, where the name is untouched, so without the literal below the
 * two halves disagree in production and the dispatch is dropped there and
 * nowhere else.
 */
export class TestJob extends Job {
  static name = "TestJob";

  async run(input: { message: string }) {
    console.log("TestJob executed:", input.message);
  }

  onFail(error: Error) {
    console.error("TestJob failed:", error);
  }
}
