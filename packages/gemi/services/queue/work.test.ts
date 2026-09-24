import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { afterAll, describe, expect, test, vi } from "vitest";

import { DatabaseQueueDriver } from "./DatabaseQueueDriver";

/**
 * `gemi queue:work`'s entry point as a real process: the properties that only
 * exist there. A worker that exits as soon as it has booted, because nothing
 * holds the event loop, passes every in-process test; so does one whose
 * SIGTERM kills it in the middle of a job. `WorkerProcess.test.ts` has the
 * rest.
 */

const ENTRY = resolve(import.meta.dirname, "work.ts");
const src = (path: string) => JSON.stringify(resolve(import.meta.dirname, path));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An application whose queue is `queue`, with one job that marks its start and end. */
function project(queue: string) {
  const root = mkdtempSync(join(tmpdir(), "gemi-work-"));
  roots.push(root);
  const files: Record<string, string> = {
    "app/kernel/Kernel.ts": `import { Kernel } from ${src("../../kernel/Kernel.ts")};
import { ApiRouter, ViewRouter } from ${src("../../http/index.ts")};
import { Mark } from "../jobs/Mark";
class RootApi extends ApiRouter { routes = {}; }
class RootView extends ViewRouter { routes = {}; }
export default class extends Kernel {
  config = {
    database: { url: ${JSON.stringify(`sqlite://${join(root, "jobs.db")}`)} },
    queue: { jobs: [Mark], pollInterval: 50, ${queue} },
    route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
  };
}`,
    "app/jobs/Mark.ts": `import { writeFileSync } from "node:fs";
import { Job } from ${src("./Job.ts")};
export class Mark extends Job {
  static name = "Mark";
  async run() {
    writeFileSync(${JSON.stringify(join(root, "started"))}, "");
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(${JSON.stringify(join(root, "finished"))}, "");
  }
}`,
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const workerEnv = {
  ...process.env,
  NODE_ENV: "production",
  GEMI_NO_SCHEDULE: "1",
  // What a web process beside it would carry, and a worker must ignore.
  GEMI_QUEUE_CLAIM: "off",
};

describe("gemi queue:work", () => {
  test("refuses the memory driver and exits 1", { timeout: 30_000 }, () => {
    const root = project("");
    const result = spawnSync("bun", [ENTRY], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: workerEnv,
    });

    expect(result.error, "could not spawn bun").toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stderr).toContain("memory driver");
    // The server's warning that it ignores GEMI_QUEUE_CLAIM=off on the memory
    // driver is not the worker's to print; it would read as "running jobs here".
    expect(result.stderr).not.toContain("GEMI_QUEUE_CLAIM");
    expect(result.status).toBe(1);
  });

  test(
    "stays up while idle, runs a job another process dispatched, and drains it on SIGTERM",
    { timeout: 30_000 },
    async () => {
      const root = project(`driver: "database"`);
      const sql = new SQL(`sqlite://${join(root, "jobs.db")}`);
      const driver = new DatabaseQueueDriver({ sql, dialect: "sqlite" });
      await driver.createTable();

      const proc = Bun.spawn(["bun", ENTRY], {
        cwd: root,
        env: workerEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // Longer than the boot and several poll intervals: an idle worker
        // whose only timer is the queue's unref'd poll has exited by now.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(proc.exitCode).toBeNull();

        await driver.enqueue({ name: "Mark", args: "[]" });
        await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true), {
          timeout: 10_000,
        });

        proc.kill("SIGTERM");
        const code = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        expect(existsSync(join(root, "finished")), stdout + stderr).toBe(true);
        expect(stdout).toContain("Shutdown complete");
        expect(code, stderr).toBe(0);
        expect([...(await sql`SELECT count(*) AS n FROM gemi_jobs`)]).toEqual([{ n: 0 }]);
      } finally {
        proc.kill("SIGKILL");
        await sql.close();
      }
    },
  );
});
