import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `Jsonify` and the client's tool types compiled the way an app compiles
 * them: `strict: true` (#1107). The package itself compiles with
 * `strict: false`, where `undefined` is erased from unions, so what happens to
 * an `undefined` member can only be checked in a separate program.
 *
 * Only diagnostics in the fixture count: gemi's own sources do not compile
 * under `strict`, and an app reads them with `skipLibCheck`.
 */

const PACKAGE = path.join(import.meta.dirname, "..");
const TSC = path.join(PACKAGE, "node_modules", ".bin", "tsc");
const FIXTURE = "ai/__fixtures__/json-types";

describe("Jsonify under strict: true", () => {
  test("the fixture compiles with no errors", { timeout: 60_000 }, () => {
    const result = Bun.spawnSync([TSC, "--noEmit", "-p", `${FIXTURE}/tsconfig.json`], {
      cwd: PACKAGE,
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    // Compiled at all: a tsconfig that stopped finding the file would pass
    // with nothing to report.
    expect(output).not.toContain("TS18003");
    expect(output).not.toContain("TS5083");
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${FIXTURE}/`));
    expect(lines).toEqual([]);
  });
});
