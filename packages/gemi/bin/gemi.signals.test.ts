import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

/**
 * `gemi dev` and `gemi run` relay `SIGTERM` to what they spawn (#566), through
 * the real CLI rather than `spawnForwardingSignals` alone — the relay is
 * `forwardSignals.test.ts`'s; what this proves is that both commands go
 * through it. Each spawns the CLI against a fixture project whose
 * `node_modules/gemi` is this package, so `gemi/bun/preload` and
 * `gemi/console/run` resolve the way they do in an app.
 *
 * The signal goes to the CLI's pid alone, not its group: a supervisor or a
 * container runtime signals the process it started, which is the case the
 * relay exists for. A group signal would reach the child directly and prove
 * nothing.
 */

const GEMI = resolve(import.meta.dirname, "gemi.ts");
const PACKAGE = resolve(import.meta.dirname, "..");
const from = (...parts: string[]) => JSON.stringify(join(PACKAGE, ...parts));

const roots: string[] = [];
// Pids a CLI without the relay would leave running, killed at the end whatever
// the assertions said.
const strays: number[] = [];

afterAll(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gemi-cli-signals-"));
  roots.push(root);
  mkdirSync(join(root, "node_modules"));
  symlinkSync(PACKAGE, join(root, "node_modules", "gemi"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/**
 * Spawns `gemi <args>` in `root`, waits for the child to print `ready`, sends
 * `SIGTERM` to the CLI, and returns what was printed and how the CLI exited.
 * The child prints its pid first, so one left behind can be cleaned up.
 */
async function signalled(root: string, args: string[], stdin?: string) {
  const proc = Bun.spawn({
    cmd: ["bun", GEMI, ...args],
    cwd: root,
    env: { ...process.env, GEMI_NO_UPDATE_CHECK: "1" },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new TextDecoder();
  let output = "";
  const read = (async () => {
    for await (const chunk of proc.stdout) output += decoder.decode(chunk);
  })();

  const started = Date.now();
  while (!output.includes("ready")) {
    if (Date.now() - started > 30_000) throw new Error(`never ready: ${JSON.stringify(output)}`);
    await Bun.sleep(20);
  }
  const pid = /child pid (\d+)/.exec(output)?.[1];
  if (pid) strays.push(Number(pid));

  proc.kill("SIGTERM");
  const code = await proc.exited;
  // Bounded: a child the CLI left running still holds the pipe open.
  await Promise.race([read, Bun.sleep(2_000)]);
  return {
    code,
    lines: output
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("child pid ")),
  };
}

// What the child does on `SIGTERM`: say so, and exit with a code of its own a
// moment later, so a CLI that stopped waiting, or dropped the code, shows.
const ON_SIGTERM = `
  process.on("SIGTERM", () => {
    console.log("child got SIGTERM");
    setTimeout(() => process.exit(7), 100);
  });
  console.log("child pid " + process.pid);
`;

describe("gemi dev", () => {
  test("relays SIGTERM to the dev server, waits for it, and exits with its code", async () => {
    const root = project({
      "app/server.ts": `${ON_SIGTERM}
        console.log("ready");
        setInterval(() => {}, 1000);
      `,
    });

    const { code, lines } = await signalled(root, ["dev"]);

    expect(lines).toEqual(["Starting dev server...", "ready", "child got SIGTERM"]);
    expect(code).toBe(7);
  }, 60_000);
});

describe("gemi run", () => {
  const root = project({
    "app/kernel/Kernel.ts": `import { Kernel } from ${from("kernel", "Kernel.ts")};
      import { ApiRouter, ViewRouter } from ${from("http", "index.ts")};
      class RootApi extends ApiRouter { routes = {}; }
      class RootView extends ViewRouter { routes = {}; }
      export default class extends Kernel {
        config = {
          command: {},
          route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
        };
      }`,
    // A long-running command that cleans up on `SIGTERM`, the backfill the
    // issue names. It echoes a line of stdin first, so the relay is shown to
    // keep the terminal attached: a confirmation prompt reads from it.
    "app/commands/Backfill.ts": `import { defineCommand } from ${from("console", "builder.ts")};
      export default defineCommand("backfill").handle(async () => {
        ${ON_SIGTERM}
        for await (const line of console) {
          console.log("stdin: " + line);
          break;
        }
        console.log("ready");
        // A pending promise alone does not keep the process alive.
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      });`,
  });

  test("relays SIGTERM to the command, waits for it, and exits with its code", async () => {
    const { code, lines } = await signalled(root, ["run", "backfill"], "yes\n");

    expect(lines).toEqual(["stdin: yes", "ready", "child got SIGTERM"]);
    expect(code).toBe(7);
  }, 60_000);
});
