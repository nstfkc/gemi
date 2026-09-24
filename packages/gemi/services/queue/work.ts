/**
 * The entry point `gemi queue:work` spawns.
 *
 * Exposed as `gemi/queue/work` and resolved by the CLI out of the
 * *application's* `node_modules`, for the reason `gemi/console/run` is: the
 * application's kernel, providers and jobs are built from its copy of gemi,
 * and the worker that drives them should be the same copy, not one bundled
 * into the CLI.
 *
 * Everything worth testing is in `QueueWorker`; this file is the order the
 * process does things in.
 */
import path from "node:path";

import { installShutdownSignals } from "../../server/shutdown";
import { projectRoot } from "../../support/discover";
import { markQueueWorker } from "./QueueManager";
import { QueueWorker, QueueWorkerRefused, type WorkerKernel } from "./WorkerProcess";

async function main(): Promise<number | undefined> {
  const rootDir = projectRoot();
  // What `Server.start` and `httpProd` set, and for the same readers: a
  // `worker = true` job's thread finds the application through them, and the
  // log provider resolves its paths from `ROOT_DIR`.
  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = path.join(rootDir, "app");
  // Before the kernel is imported, so no claim rule can be asked first.
  markQueueWorker();

  const kernelPath = path.join(rootDir, "app/kernel/Kernel.ts");
  const { default: Kernel } = (await import(kernelPath)) as {
    default?: new () => WorkerKernel & { boot(): void };
  };
  if (typeof Kernel !== "function") {
    console.error(`[gemi] ${kernelPath} has no default export to boot the worker from.`);
    return 1;
  }
  const kernel = new Kernel();
  kernel.boot();

  const worker = new QueueWorker(kernel);
  // Before the boot, as `Server.start` does in production: the boot is the
  // slow part, and a signal that lands in it would otherwise kill the process
  // on the spot. In development too, unlike a server — no `bun --hot` re-runs
  // this, and a Ctrl+C that lets the jobs finish is what a worker is for.
  installShutdownSignals(() => worker.stop());

  try {
    await worker.start();
  } catch (error) {
    if (!(error instanceof QueueWorkerRefused)) throw error;
    console.error(error.message);
    return 1;
  }
  // Running: the signal handler exits the process once it has drained.
  return undefined;
}

main().then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (error) => {
    console.error("[gemi] The queue worker failed to start:", error);
    process.exit(1);
  },
);
