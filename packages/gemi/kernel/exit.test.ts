import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Importing the kernel must let the process exit.
 *
 * #316's third item: `await import("gemi/kernel")` resolved in ~110ms and then
 * hung forever — no open sockets, no timers, an empty kqueue, and
 * `getActiveResourcesInfo()` returning `[]`. Every one-off script that touched
 * the kernel needed an explicit `process.exit()` or it held CI open until the
 * job timed out.
 *
 * The cause was one module-scope import. `react-dom/server.browser` on React
 * 19.2.3 keeps a Bun process alive on its own — importing nothing else and
 * rendering nothing is enough — and `ViewRouteDispatcher` had it at the top,
 * which puts it in the graph of anything reaching `RouteServiceProvider`. It is
 * loaded on first render now; see the note there.
 *
 * **Asserted by running it rather than by reading the import list.** A static
 * check that `react-dom/server.browser` is absent would pass while the same
 * hang came back through a different module, and would fail on a lazy import
 * that is perfectly fine. The property anybody cares about is that the process
 * ends, so that is what is measured — in a subprocess, because a test runner
 * cannot observe its own exit.
 */
describe("a script that imports the kernel", () => {
  const entry = join(import.meta.dirname, "index.ts");

  /**
   * The bound is `spawnSync`'s, not vitest's: a synchronous spawn blocks the
   * runner's loop, so its own `testTimeout` cannot fire and this is what
   * decides how long a regression takes to report. The happy path is ~200ms, so
   * ten seconds is margin rather than a guess.
   */
  test("exits on its own", { timeout: 15_000 }, () => {
    const result = spawnSync(
      "bun",
      ["-e", `await import(${JSON.stringify(entry)}); console.log("loaded")`],
      { encoding: "utf8", timeout: 10_000 },
    );

    // Checked first because it is the outcome that looks like the others. A
    // `bun` that is not on PATH gives `status: null` and `signal: null` and
    // sets `error` — so without this the assertions below pass, and the
    // environment problem surfaces as `expected undefined to contain "loaded"`,
    // which names neither the cause nor the fix.
    expect(result.error, "could not spawn bun").toBeUndefined();

    // `signal` is what a timeout kill shows up as, and it is the failure this
    // test is for — distinguished from an ordinary non-zero exit, which would
    // mean the import itself broke and is a different bug.
    expect(result.signal, result.stderr).toBeNull();
    expect(result.stdout).toContain("loaded");
    expect(result.status).toBe(0);
  });
});
