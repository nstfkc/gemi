import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

/**
 * A `worker = true` job, run in its thread from a real process (#1318, #1325).
 * The thread used to import `app/bootstrap.ts` (`dist/server/bootstrap.mjs` in
 * production), which no template has and no build emitted, and a thread that
 * failed to load left the job unsettled forever. Then every job booted a
 * thread of its own, the whole application with it, and ended it after one
 * job; now the threads are pooled and kept.
 */

const src = (path: string) => JSON.stringify(resolve(import.meta.dirname, path));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * An application with one worker job, `Cpu`, which appends a line per run to
 * `ran`, and a daily cron job; the kernel appends a line per import to
 * `boots`. What `Cpu` does is chosen by its second argument: `"x"` returns,
 * `"hang"` never does, `"crash"` throws outside the job, and `"slow"` takes a
 * second first.
 */
function project(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "gemi-worker-"));
  roots.push(root);
  const files: Record<string, string> = {
    "app/kernel/Kernel.ts": `import { appendFileSync } from "node:fs";
import { Kernel } from ${src("../../kernel/Kernel.ts")};
import { ApiRouter, ViewRouter } from ${src("../../http/index.ts")};
import { CronJob } from ${src("../cron/CronJob.ts")};
import { Cpu } from "../jobs/Cpu";
appendFileSync(${JSON.stringify(join(root, "boots"))}, "boot\\n");
class Nightly extends CronJob { name = "Nightly"; cron = "@daily"; }
class RootApi extends ApiRouter { routes = {}; }
class RootView extends ViewRouter { routes = {}; }
export default class extends Kernel {
  config = {
    queue: { jobs: [Cpu] },
    schedule: { jobs: [Nightly] },
    route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
  };
}`,
    "app/jobs/Cpu.ts": `import { appendFileSync } from "node:fs";
import { isMainThread, threadId } from "node:worker_threads";
import { Job } from ${src("./Job.ts")};
import { app } from ${src("../../foundation/app.ts")};
import { claimsInThisProcess, QueueManager } from ${src("./QueueManager.ts")};
import { isJobThread } from ${src("./WorkerPool.ts")};
export class Cpu extends Job {
  static name = "Cpu";
  worker = true;
  maxAttempts = 1;
  async run(a: number, b: string) {
    if (b === "hang") while (true) {}
    if (b === "crash") {
      setTimeout(() => { throw new Error("thread exploded"); });
      return new Promise(() => {});
    }
    if (b === "slow") await new Promise((r) => setTimeout(r, 1000));
    appendFileSync(${JSON.stringify(join(root, "ran"))}, JSON.stringify({
      a, b, isMainThread, threadId,
      marker: (globalThis as any).bootstrapMarker ?? null,
      jobThread: isJobThread(),
      claims: claimsInThisProcess(),
      cronJobs: (globalThis as any).__gemiCronJobs?.size ?? 0,
      registered: app(QueueManager).registeredJobs.length,
    }) + "\\n");
    return a * 2;
  }
}`,
    // Runs the jobs listed in RUN, one after another unless PARALLEL is set,
    // and prints each outcome.
    "push.ts": `import { QueueManager } from ${src("./QueueManager.ts")};
import { Cpu } from "./app/jobs/Cpu";
process.env.ROOT_DIR = ${JSON.stringify(root)};
process.env.APP_DIR = ${JSON.stringify(join(root, "app"))};
let settle: () => void = () => {};
class Watched extends Cpu {
  static name = "Cpu";
  workerTimeout = Number(process.env.WORKER_TIMEOUT ?? 600_000);
  onSuccess(result: unknown) { console.log("SUCCEEDED " + JSON.stringify(result)); settle(); }
  onDeadletter(error: Error) { console.log("DEADLETTERED " + error?.name + ": " + (error?.message ?? error)); settle(); }
}
const queue = new QueueManager({ jobs: [Watched], pollInterval: 20, concurrency: 4 });
setTimeout(() => { console.log("HUNG"); process.exit(1); }, 25_000);
const runs = (process.env.RUN ?? "x").split(",");
if (process.env.PARALLEL) {
  let left = runs.length;
  const all = new Promise<void>((r) => (settle = () => { if (--left === 0) r(); }));
  for (const [i, b] of runs.entries()) await queue.push(Watched, JSON.stringify([21 + i, b]));
  await all;
} else {
  for (const [i, b] of runs.entries()) {
    const done = new Promise<void>((r) => (settle = r));
    await queue.push(Watched, JSON.stringify([21 + i, b]));
    await done;
  }
}
console.log("THREADS " + queue.workerPool.threads);
process.exit(0);`,
    ...extra,
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

function push(root: string, env: Record<string, string>) {
  const result = spawnSync("bun", [join(root, "push.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: 35_000,
    env: { ...process.env, GEMI_NO_SCHEDULE: "1", ...env },
  });
  expect(result.error, "could not spawn bun").toBeUndefined();
  return { out: result.stdout, err: result.stderr };
}

const lines = (root: string, file: string) =>
  existsSync(join(root, file))
    ? readFileSync(join(root, file), "utf8").trim().split("\n").filter(Boolean)
    : [];
const runs = (root: string) => lines(root, "ran").map((line) => JSON.parse(line));

describe("worker = true", () => {
  for (const mode of ["production", "development"]) {
    test(`runs in a thread booted from the kernel, with no bootstrap file (${mode})`, { timeout: 40_000 }, () => {
      const root = project();
      const { out, err } = push(root, { NODE_ENV: mode });
      expect(out, err).toContain("SUCCEEDED 42");
      // Spread, as everywhere else: `run(21, "x")`, not `run([21, "x"])`.
      expect(runs(root)).toEqual([
        expect.objectContaining({ a: 21, b: "x", isMainThread: false, marker: null }),
      ]);
    });
  }

  test("uses the app's own bootstrap when it has one, and imports it once", { timeout: 40_000 }, () => {
    const root = project({
      "app/bootstrap.ts": `import { App } from ${src("../../app/index.ts")};
import Kernel from "./kernel/Kernel";
(globalThis as any).bootstrapMarker = "bootstrap.ts";
export const app = new App({ kernel: Kernel });
await app.waitForBoot();`,
    });
    const { out, err } = push(root, { NODE_ENV: "development", RUN: "x,x" });
    expect(out, err).toContain("SUCCEEDED 42");
    expect(out, err).toContain("SUCCEEDED 44");
    expect(runs(root).map((run) => run.marker)).toEqual(["bootstrap.ts", "bootstrap.ts"]);
    expect(lines(root, "boots")).toHaveLength(1);
  });

  test("a thread that cannot load the app fails the job instead of hanging", { timeout: 40_000 }, () => {
    const root = project();
    writeFileSync(join(root, "app/kernel/Kernel.ts"), `throw new Error("kernel exploded");`);
    const { out, err } = push(root, { NODE_ENV: "production", RUN: "x,x" });
    // Each job fails, rather than the first taking the pool down with it.
    expect(out.match(/DEADLETTERED.*kernel exploded/g), err).toHaveLength(2);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("reuses the booted thread: later jobs do not boot the app again (#1325)", { timeout: 40_000 }, () => {
    const root = project();
    const { out, err } = push(root, { NODE_ENV: "production", RUN: "x,x,x" });
    expect(out, err).toContain("SUCCEEDED 46");
    const ran = runs(root);
    expect(ran).toHaveLength(3);
    expect(new Set(ran.map((run) => run.threadId)).size).toBe(1);
    expect(lines(root, "boots")).toHaveLength(1);
    expect(out).toContain("THREADS 1");
  });

  test("jobs at once share at most workerThreads threads", { timeout: 40_000 }, () => {
    const root = project();
    writeFileSync(
      join(root, "push.ts"),
      readFileSync(join(root, "push.ts"), "utf8").replace(
        "concurrency: 4 }",
        "concurrency: 4, workerThreads: 2 }",
      ),
    );
    const { out, err } = push(root, {
      NODE_ENV: "production",
      RUN: "slow,slow,slow,slow",
      PARALLEL: "1",
    });
    expect(out.match(/SUCCEEDED/g), err).toHaveLength(4);
    expect(new Set(runs(root).map((run) => run.threadId)).size).toBe(2);
    expect(lines(root, "boots")).toHaveLength(2);
  });

  test("the thread starts no cron schedule and claims nothing, with no GEMI_NO_SCHEDULE", { timeout: 40_000 }, () => {
    const root = project();
    // The schedule would start in a server here: not under vitest's rule, and
    // not turned off.
    const { out, err } = push(root, {
      NODE_ENV: "production",
      GEMI_NO_SCHEDULE: "",
      GEMI_SCHEDULE: "1",
    });
    expect(out, err).toContain("SUCCEEDED 42");
    expect(runs(root)).toEqual([
      expect.objectContaining({ jobThread: true, claims: false, cronJobs: 0 }),
    ]);
  });

  test("a job reaches the application booted in its thread", { timeout: 40_000 }, () => {
    const root = project();
    const { out, err } = push(root, { NODE_ENV: "production", RUN: "x,x" });
    expect(out, err).toContain("SUCCEEDED 44");
    expect(runs(root).map((run) => run.registered)).toEqual([1, 1]);
  });

  test("a job past its workerTimeout fails, and the next job gets a new thread", { timeout: 40_000 }, () => {
    const root = project();
    const { out, err } = push(root, {
      NODE_ENV: "production",
      RUN: "hang,x",
      WORKER_TIMEOUT: "1500",
    });
    expect(out, err).toContain("DEADLETTERED WorkerTimeoutError");
    expect(out).toContain("SUCCEEDED 44");
    // One boot for the thread that hung, one for its replacement.
    expect(lines(root, "boots")).toHaveLength(2);
    expect(out).toContain("THREADS 1");
  });

  test("a thread that crashes fails only its job and is replaced", { timeout: 40_000 }, () => {
    const root = project();
    const { out, err } = push(root, { NODE_ENV: "production", RUN: "x,crash,x" });
    expect(out, err).toContain("SUCCEEDED 42");
    expect(out).toContain("thread exploded");
    expect(out).toContain("SUCCEEDED 46");
    const ran = runs(root);
    expect(ran.map((run) => run.a)).toEqual([21, 23]);
    expect(ran[0].threadId).not.toBe(ran[1].threadId);
    expect(lines(root, "boots")).toHaveLength(2);
  });
});
