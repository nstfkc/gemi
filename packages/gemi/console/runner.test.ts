import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { Scheduler } from "../services/cron/Scheduler";
import { runConsole } from "./runner";

/**
 * `gemi run`, over an application directory on disk.
 *
 * `parse.ts` and the registry are covered by their own files without any of
 * this. What is left needs a real project: a Kernel that boots, a config slice
 * read before defaults are applied, command files imported off the filesystem,
 * and the ordering that decides which of those an invocation pays for.
 *
 * The fixtures import `defineCommand` by absolute path rather than from
 * `gemi/services`, since a temp directory has no `node_modules` above it to
 * resolve that through — the path lands on the very module this file imports
 * from, so the class identity `discoverClasses` walks the prototype chain for
 * holds. The real thing resolves it through the application's own gemi, which is
 * exactly why `gemi run` spawns a process rather than doing this in the CLI, and
 * is the one property this file cannot check. `bin/gemi.ts` and a real project
 * are where that is observable.
 */

const BUILDER = JSON.stringify(resolve(import.meta.dirname, "builder.ts"));
const KERNEL = JSON.stringify(
  resolve(import.meta.dirname, "../kernel/Kernel.ts"),
);
const HTTP = JSON.stringify(resolve(import.meta.dirname, "../http/index.ts"));

/**
 * The smallest `route` slice `RouteServiceProvider.boot` will accept.
 *
 * It is here because running a command boots the application the way the server
 * does, and that provider force-resolves both dispatchers rather than building
 * them lazily — so an app with no root router cannot complete phase two. Every
 * real application has `app/config/route.ts`; a fixture has to say so too, and
 * the tests that never reach phase two prove they never reach it by passing
 * without ever exercising this.
 */
const ROUTES = `import { ApiRouter, ViewRouter } from ${HTTP};
class RootApi extends ApiRouter { routes = {}; }
class RootView extends ViewRouter { routes = {}; }
const route = { api: { rootRouter: RootApi }, view: { rootRouter: RootView } };`;

const roots: string[] = [];

/** An application tree in a temp directory. Keys are paths, values are source. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gemi-console-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** A Kernel with nothing but the `command` slice the test is about. */
const kernel = (slice = "{}") => `import { Kernel } from ${KERNEL};
${ROUTES}
export default class extends Kernel {
  config = { command: ${slice}, route };
  async waitForBoot() {
    globalThis.__consoleBoots = (globalThis.__consoleBoots ?? 0) + 1;
    await super.waitForBoot();
  }
}`;

const command = (name: string, body = "", chain = "") =>
  `import { defineCommand } from ${BUILDER};
export default defineCommand(${JSON.stringify(name)})${chain}
  .handle(async (ctx) => { ${body} });`;

/** Runs the console against a fixture, capturing both streams separately. */
async function run(
  root: string,
  name?: string,
  argv: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const code = await runConsole({
    rootDir: root,
    name,
    argv,
    writers: {
      stdout: (chunk) => (stdout += chunk),
      stderr: (chunk) => (stderr += chunk),
    },
  });

  return { code, stdout, stderr };
}

const boots = () => (globalThis as any).__consoleBoots ?? 0;

beforeAll(() => {
  // What `gemi run` sets on the process it spawns. Without it every fixture that
  // reaches phase two would register `Bun.cron` handles and leave them ticking
  // into the next test file.
  process.env.GEMI_NO_SCHEDULE = "1";
});

afterEach(() => {
  (globalThis as any).__consoleBoots = 0;
  for (const [name, handle] of globalThis.__gemiCronJobs ?? []) {
    handle.stop();
    globalThis.__gemiCronJobs?.delete(name);
  }
});

afterAll(() => {
  delete process.env.GEMI_NO_SCHEDULE;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("listing what an application has", () => {
  test("no name prints the commands and their descriptions", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed", "", `.describe("Seed it")`),
      "app/commands/Digest.ts": command(
        "send-digest",
        "",
        `.describe("Send it")`,
      ),
    });

    const { code, stdout } = await run(root);

    expect(code).toBe(0);
    expect(stdout).toContain("db:seed");
    expect(stdout).toContain("Seed it");
    expect(stdout).toContain("send-digest");
  });

  test("the listing is sorted, so it does not depend on the filesystem", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/A.ts": command("zebra"),
      "app/commands/Z.ts": command("aardvark"),
    });

    const { stdout } = await run(root);

    expect(stdout.indexOf("aardvark")).toBeLessThan(stdout.indexOf("zebra"));
  });

  test("an empty directory says where it looked and how to register one", async () => {
    const root = project({ "app/kernel/Kernel.ts": kernel() });

    const { code, stdout } = await run(root);

    expect(code).toBe(0);
    expect(stdout).toContain("No commands found");
    expect(stdout).toContain("app/commands");
  });
});

describe("the config slice", () => {
  test("absent commands discovers the directory", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed"),
    });

    expect((await run(root)).stdout).toContain("db:seed");
  });

  /**
   * Declared wins, and `[]` is declared. The slice has to be read before
   * `withDefaults`, which collapses absent and `undefined` into the default `[]`
   * — the same value an app writes when it means "none, and I mean it".
   */
  test("an empty declared list means none, and does not read the directory", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel("{ commands: [] }"),
      "app/commands/Seed.ts": command("db:seed"),
    });

    const { stdout } = await run(root);

    expect(stdout).not.toContain("db:seed");
    expect(stdout).toContain("declares no commands");
  });

  test("a declared list is used verbatim, whatever the directory holds", async () => {
    const root = project({
      "app/kernel/Kernel.ts": `import { Kernel } from ${KERNEL};
import Declared from "../commands/Declared.ts";
${ROUTES}
export default class extends Kernel {
  config = { command: { commands: [Declared] }, route };
}`,
      "app/commands/Declared.ts": command("declared"),
      "app/commands/Ignored.ts": command("ignored"),
    });

    const { stdout } = await run(root);

    expect(stdout).toContain("declared");
    expect(stdout).not.toContain("ignored");
  });

  test("commandsDir moves the walk", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(`{ commandsDir: "app/tasks" }`),
      "app/tasks/Seed.ts": command("db:seed"),
      "app/commands/Elsewhere.ts": command("elsewhere"),
    });

    const { stdout } = await run(root);

    expect(stdout).toContain("db:seed");
    expect(stdout).not.toContain("elsewhere");
  });
});

describe("a name that does not match", () => {
  test("is reported with a suggestion and the listing, and exits 1", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed"),
    });

    const { code, stdout, stderr } = await run(root, "db:sed");

    expect(code).toBe(1);
    expect(stderr).toContain("No command named `db:sed`");
    expect(stderr).toContain("Did you mean `db:seed`");
    // The whole report is a diagnostic, so none of it lands on stdout.
    expect(stdout).toBe("");
  });
});

describe("help", () => {
  test("renders the declared schema and exits 0", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command(
        "db:seed",
        "",
        `.describe("Seed it")
  .arg("tenant", { required: true, description: "Which tenant" })
  .option("dryRun", { type: "boolean", description: "Print the plan" })
  .option("limit", { type: "number", default: 50 })`,
      ),
    });

    const { code, stdout } = await run(root, "db:seed", ["--help"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: gemi run db:seed [options] <tenant>");
    expect(stdout).toContain("Which tenant");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--limit <number>");
    expect(stdout).toContain("(default: 50)");
  });
});

describe("running one", () => {
  test("hands the handler its parsed arguments and options", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Echo.ts": command(
        "echo",
        `ctx.line(JSON.stringify({ args: ctx.args, options: ctx.options }));`,
        `.arg("who", { required: true })
  .arg("rest", { variadic: true })
  .option("loud", { type: "boolean" })
  .option("times", { type: "number", default: 1 })`,
      ),
    });

    const { code, stdout } = await run(root, "echo", [
      "world",
      "a",
      "b",
      "--loud",
      "--times=3",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      args: { who: "world", rest: ["a", "b"] },
      options: { loud: true, times: 3 },
    });
  });

  test("a usage error prints the usage and exits 1 without running anything", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Echo.ts": command(
        "echo",
        `ctx.line("RAN");`,
        `.arg("who", { required: true })`,
      ),
    });

    const { code, stdout, stderr } = await run(root, "echo");

    expect(code).toBe(1);
    expect(stderr).toContain("Missing required argument <who>.");
    expect(stderr).toContain("Usage: gemi run echo");
    expect(stdout).not.toContain("RAN");
  });

  /**
   * The split a piped command depends on: `TOTAL=$(gemi run count)` has to
   * capture the answer and nothing else.
   */
  test("line goes to stdout and error goes to stderr", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Both.ts": command(
        "both",
        `ctx.line("the answer"); ctx.error("a diagnostic");`,
      ),
    });

    const { stdout, stderr } = await run(root, "both");

    expect(stdout.trim()).toBe("the answer");
    expect(stderr.trim()).toBe("a diagnostic");
  });
});

describe("exit codes", () => {
  const withReturn = (body: string) =>
    project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Ret.ts": command("ret", body),
    });

  test("returning nothing succeeds", async () => {
    expect((await run(withReturn(""), "ret")).code).toBe(0);
  });

  test("returning an integer is the exit code", async () => {
    expect((await run(withReturn("return 3;"), "ret")).code).toBe(3);
    expect((await run(withReturn("return 0;"), "ret")).code).toBe(0);
  });

  /**
   * `return users.length` is an easy thing to write, and coercing it would turn
   * 300 backfilled users into exit status 44 — which reads as a failure to
   * everything downstream, for a command that succeeded.
   */
  test("returning something that is not an exit code says so and fails", async () => {
    const { code, stderr } = await run(withReturn("return 300;"), "ret");

    expect(code).toBe(1);
    expect(stderr).toContain("not an exit code");
  });

  test("fail() carries its message and code, with no stack", async () => {
    const { code, stdout, stderr } = await run(
      withReturn(`ctx.fail("nothing to do", 2);`),
      "ret",
    );

    expect(code).toBe(2);
    expect(stderr.trim()).toBe("nothing to do");
    // A stack frame, not the letters — the sentences these commands print are
    // English and "what turns" contains "at ".
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stdout).toBe("");
  });

  test("an unexpected throw keeps its stack, because it is a bug", async () => {
    const { code, stderr } = await run(
      withReturn(`throw new Error("boom");`),
      "ret",
    );

    expect(code).toBe(1);
    expect(stderr).toContain("boom");
    expect(stderr).toMatch(/^\s+at /m);
  });
});

describe("what an invocation pays for", () => {
  /**
   * Listing, an unknown name and `--help` are the three things an operator does
   * most often, and none of them needs anything from the application beyond its
   * config. Booting for them would open a database connection to answer a
   * question about a directory.
   */
  test("listing, a miss and help all resolve without booting", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed"),
    });

    await run(root);
    await run(root, "nope");
    await run(root, "db:seed", ["--help"]);
    await run(root, "db:seed", ["--bogus"]);

    expect(boots()).toBe(0);
  });

  test("running one does boot, so a command sees the container", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed"),
    });

    await run(root, "db:seed");

    expect(boots()).toBe(1);
  });

  test("a command resolves services the way a request handler does", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Sched.ts": command(
        "sched",
        `const { app } = await import(${JSON.stringify(resolve(import.meta.dirname, "../foundation/app.ts"))});
         const { Scheduler } = await import(${JSON.stringify(resolve(import.meta.dirname, "../services/cron/Scheduler.ts"))});
         ctx.line(String(app(Scheduler) instanceof Scheduler));`,
      ),
    });

    const { code, stdout } = await run(root, "sched");

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("true");
  });

  /**
   * `gemi run` sets `GEMI_NO_SCHEDULE=1` on the process it spawns. Booting the
   * application is how a command reaches the container; starting the schedule is
   * a side effect of that which nobody asked for, and a long backfill would
   * otherwise fire the whole schedule in a process no operator is watching.
   */
  test("booting for a command does not start the schedule", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Seed.ts": command("db:seed"),
      "app/cron/Daily.ts": `import { CronJob } from ${JSON.stringify(resolve(import.meta.dirname, "../services/cron/CronJob.ts"))};
export class Daily extends CronJob {
  name = "Daily";
  cron = "* * * * *";
  async callback() {}
}`,
    });

    await run(root, "db:seed");

    expect(globalThis.__gemiCronJobs?.size ?? 0).toBe(0);
  });
});

describe("an application that cannot be read", () => {
  test("a missing Kernel is a sentence, not a stack", async () => {
    const root = project({ "app/commands/Seed.ts": command("db:seed") });

    const { code, stderr } = await run(root);

    expect(code).toBe(1);
    expect(stderr).toContain("Could not load");
    expect(stderr).toContain("root of a gemi project");
  });

  test("a Kernel with no default export says so", async () => {
    const root = project({
      "app/kernel/Kernel.ts": `export const NotDefault = 1;`,
    });

    const { code, stderr } = await run(root);

    expect(code).toBe(1);
    expect(stderr).toContain("no default export");
  });

  /**
   * The one silence the builder introduces: a chain that never reached
   * `.handle()` is a plain object, so discovery discards it and the command
   * disappears from the listing with nothing raised.
   */
  test("a builder that never called handle refuses by name", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Half.ts": `import { defineCommand } from ${BUILDER};
export default defineCommand("half-written").arg("who");`,
    });

    const { code, stderr } = await run(root);

    expect(code).toBe(1);
    expect(stderr).toContain("Half.ts");
    expect(stderr).toContain("never called `.handle()`");
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test("two commands claiming one name refuse rather than picking", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/One.ts": command("db:seed"),
      "app/commands/Two.ts": command("db:seed"),
    });

    const { code, stderr } = await run(root);

    expect(code).toBe(1);
    expect(stderr).toContain('Two commands are named "db:seed"');
  });
});

describe("teardown", () => {
  test("the container is flushed even when the command threw", async () => {
    const root = project({
      "app/kernel/Kernel.ts": kernel(),
      "app/commands/Boom.ts": command("boom", `throw new Error("boom");`),
    });

    await run(root, "boom");

    // `destroy()` clears the static instance and stops a resolved Scheduler.
    // A command that threw must not leave either behind for the next process —
    // or, here, the next test.
    expect(globalThis.__gemiCronJobs?.size ?? 0).toBe(0);
    expect(() => new Scheduler({ jobs: [] } as any)).not.toThrow();
  });
});
