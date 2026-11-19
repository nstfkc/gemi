import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

/**
 * A `worker = true` job, run in its thread from a real process (#1318). The
 * thread used to import `app/bootstrap.ts` (`dist/server/bootstrap.mjs` in
 * production), which no template has and no build emitted, and a thread that
 * failed to load left the job unsettled forever.
 */

const src = (path: string) => JSON.stringify(resolve(import.meta.dirname, path));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An application with one worker job, `Cpu`, that writes its arguments and thread. */
function project(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "gemi-worker-"));
  roots.push(root);
  const files: Record<string, string> = {
    "app/kernel/Kernel.ts": `import { Kernel } from ${src("../../kernel/Kernel.ts")};
import { ApiRouter, ViewRouter } from ${src("../../http/index.ts")};
import { Cpu } from "../jobs/Cpu";
class RootApi extends ApiRouter { routes = {}; }
class RootView extends ViewRouter { routes = {}; }
export default class extends Kernel {
  config = {
    queue: { jobs: [Cpu] },
    route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
  };
}`,
    "app/jobs/Cpu.ts": `import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { Job } from ${src("./Job.ts")};
export class Cpu extends Job {
  static name = "Cpu";
  worker = true;
  maxAttempts = 1;
  run(a: number, b: string) {
    writeFileSync(${JSON.stringify(join(root, "ran"))}, JSON.stringify({ a, b, isMainThread, marker: (globalThis as any).bootstrapMarker ?? null }));
    return a * 2;
  }
}`,
    "push.ts": `import { QueueManager } from ${src("./QueueManager.ts")};
import { Cpu } from "./app/jobs/Cpu";
process.env.ROOT_DIR = ${JSON.stringify(root)};
process.env.APP_DIR = ${JSON.stringify(join(root, "app"))};
class Watched extends Cpu {
  static name = "Cpu";
  onSuccess(result: unknown) { console.log("SUCCEEDED " + JSON.stringify(result)); process.exit(0); }
  onDeadletter(error: Error) { console.log("DEADLETTERED " + (error?.message ?? error)); process.exit(0); }
}
const queue = new QueueManager({ jobs: [Watched], pollInterval: 20 });
await queue.push(Watched, JSON.stringify([21, "x"]));
setTimeout(() => { console.log("HUNG"); process.exit(1); }, 15_000);`,
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
    timeout: 25_000,
    env: { ...process.env, GEMI_NO_SCHEDULE: "1", ...env },
  });
  expect(result.error, "could not spawn bun").toBeUndefined();
  return { out: result.stdout, err: result.stderr };
}

describe("worker = true", () => {
  for (const mode of ["production", "development"]) {
    test(`runs in a thread booted from the kernel, with no bootstrap file (${mode})`, { timeout: 30_000 }, () => {
      const root = project();
      const { out, err } = push(root, { NODE_ENV: mode });
      expect(out, err).toContain("SUCCEEDED 42");
      // Spread, as everywhere else: `run(21, "x")`, not `run([21, "x"])`.
      expect(JSON.parse(readFileSync(join(root, "ran"), "utf8"))).toEqual({
        a: 21,
        b: "x",
        isMainThread: false,
        marker: null,
      });
    });
  }

  test("uses the app's own bootstrap when it has one", { timeout: 30_000 }, () => {
    const root = project({
      "app/bootstrap.ts": `import { App } from ${src("../../app/index.ts")};
import Kernel from "./kernel/Kernel";
(globalThis as any).bootstrapMarker = "bootstrap.ts";
export const app = new App({ kernel: Kernel });
await app.waitForBoot();`,
    });
    const { out, err } = push(root, { NODE_ENV: "development" });
    expect(out, err).toContain("SUCCEEDED 42");
    expect(JSON.parse(readFileSync(join(root, "ran"), "utf8")).marker).toBe("bootstrap.ts");
  });

  test("a thread that cannot load the app fails the job instead of hanging", { timeout: 30_000 }, () => {
    const root = project();
    writeFileSync(join(root, "app/kernel/Kernel.ts"), `throw new Error("kernel exploded");`);
    const { out, err } = push(root, { NODE_ENV: "production" });
    expect(out, err).toContain("DEADLETTERED");
    expect(out).toContain("kernel exploded");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });
});
