import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

/**
 * The two properties of `gemi run` that only exist in a real process.
 *
 * `runner.test.ts` calls `runConsole` directly, which is the right seam for
 * almost everything — but it starts *after* argv handling and ends by returning
 * an exit code instead of taking one. The two things `run.ts` does either side
 * of that are invisible to it, and both were wrong:
 *
 *   - it consumed the `--` the escape hatch is made of, before the only code
 *     that reads one; and
 *   - it exited so promptly that piped stdout was truncated at the pipe buffer,
 *     with status 0.
 *
 * Both need a spawn to observe, in the idiom `kernel/exit.test.ts` established:
 * a synchronous one, so the process's own exit is what is being measured.
 */

const RUN = resolve(import.meta.dirname, "run.ts");
const BUILDER = JSON.stringify(resolve(import.meta.dirname, "builder.ts"));
const KERNEL = JSON.stringify(
  resolve(import.meta.dirname, "../kernel/Kernel.ts"),
);
const HTTP = JSON.stringify(resolve(import.meta.dirname, "../http/index.ts"));

const roots: string[] = [];

/** An application whose single command is `body`. See `runner.test.ts`. */
function project(name: string, body: string, chain = ""): string {
  const root = mkdtempSync(join(tmpdir(), "gemi-run-"));
  roots.push(root);

  const files: Record<string, string> = {
    "app/kernel/Kernel.ts": `import { Kernel } from ${KERNEL};
import { ApiRouter, ViewRouter } from ${HTTP};
class RootApi extends ApiRouter { routes = {}; }
class RootView extends ViewRouter { routes = {}; }
export default class extends Kernel {
  config = {
    command: {},
    route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
  };
}`,
    "app/commands/Cmd.ts": `import { defineCommand } from ${BUILDER};
export default defineCommand(${JSON.stringify(name)})${chain}
  .handle(async (ctx) => { ${body} });`,
  };

  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }

  return root;
}

/** Spawns the real entry point against a fixture, over a pipe. */
function run(root: string, argv: string[]) {
  const result = spawnSync("bun", [RUN, ...argv], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    // The default is 1 MB, which the truncation test would hit on its own and
    // report as a failure of the thing it is measuring.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GEMI_NO_SCHEDULE: "1" },
  });

  // Checked first: a `bun` that is not on PATH sets `error` and leaves both
  // `status` and `signal` null, which otherwise surfaces as a confusing
  // assertion about stdout rather than as an environment problem.
  expect(result.error, "could not spawn bun").toBeUndefined();
  // A timeout kill shows up here, and is the shape a hang takes.
  expect(result.signal, result.stderr).toBeNull();

  return result;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("the -- escape hatch", () => {
  const fixture = () =>
    project(
      "echo",
      `ctx.line(JSON.stringify(ctx.args.rest));`,
      `.arg("rest", { variadic: true }).option("dryRun", { type: "boolean" })`,
    );

  /**
   * commander hands a `--` through as a literal operand, and `parse.ts` already
   * treats one as "everything after this is positional". Stripping it in between
   * — which an earlier draft did — meant the documented escape hatch reported
   * `Unknown option --dry-run`, and `-- --` typed twice was the only way through.
   */
  test("passes a flag-shaped value through as an argument", () => {
    const result = run(fixture(), ["echo", "--", "--dry-run"]);

    expect(result.stdout.trim(), result.stderr).toBe('["--dry-run"]');
    expect(result.status).toBe(0);
  });

  test("without it, the same token is still read as the flag", () => {
    const result = run(fixture(), ["echo", "--dry-run"]);

    expect(result.stdout.trim()).toBe("[]");
    expect(result.status).toBe(0);
  });
});

describe("output that outgrows the pipe buffer", () => {
  /**
   * `process.stdout.write` is asynchronous on a pipe and `run.ts` ends in an
   * explicit `process.exit`, so without a flush the two together truncate at the
   * buffer — measured at exactly 65,536 bytes of a 2 MB write on Bun 1.3.14,
   * while exiting 0. `gemi run export-users | gzip > out.gz` stored a fragment
   * and reported success.
   *
   * A subprocess is the only way to see it: `spawnSync` captures stdout over a
   * pipe, which is the affected path, and an in-process test with injected
   * writers never touches a stream at all.
   */
  test("survives intact, and the command still exits on its own", () => {
    const size = 2_000_000;
    const root = project("dump", `ctx.line("x".repeat(${size}));`);

    const result = run(root, ["dump"]);

    expect(result.status, result.stderr).toBe(0);
    // The `\n` `line` adds. An assertion on the exact length rather than on
    // `toContain`, because truncation is the failure and a prefix match cannot
    // see it.
    expect(result.stdout.length).toBe(size + 1);
  }, 60_000);

  test("stderr is flushed too, so a diagnostic is not lost to the exit", () => {
    const size = 500_000;
    const root = project("warn", `ctx.error("y".repeat(${size})); return 3;`);

    const result = run(root, ["warn"]);

    expect(result.status).toBe(3);
    expect(result.stderr.length).toBe(size + 1);
  }, 60_000);
});
