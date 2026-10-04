import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `toAgentTools` and `ToolShapesOf` compiled the way an app compiles them:
 * `strict: true` (#771).
 *
 * The package itself compiles with `strict: false`, and so does every
 * `*.test-d.ts`; an app reads the client's tool parts under `strict`, and
 * that is where an untyped MCP tool collapsed every part, the native tools'
 * included. Hence a separate program, with its own `tsconfig`.
 *
 * Only diagnostics in the fixture count. gemi's own sources do not compile
 * under `strict`, and an app never sees that: it reads gemi's declarations
 * with `skipLibCheck`.
 */

const PACKAGE = path.join(import.meta.dirname, "..", "..");
const TSC = path.join(PACKAGE, "node_modules", ".bin", "tsc");
const FIXTURE = "services/mcp/__fixtures__/agent-tools-strict";

describe("toAgentTools under strict: true", () => {
  test(
    "a typed router's tools keep their names and types, beside the agent's own",
    { timeout: 60_000 },
    () => {
      const result = Bun.spawnSync(
        [TSC, "--noEmit", "-p", `${FIXTURE}/tsconfig.json`],
        {
          cwd: PACKAGE,
        },
      );
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      const lines = output.split("\n").map((line) => line.trim());

      // The fixture has to have been compiled at all: a tsconfig that stopped
      // finding it would leave nothing to report and pass vacuously.
      expect(output).not.toContain("TS18003");
      expect(output).not.toContain("TS5083");

      // Its `@ts-expect-error`s are part of this: an unused one is TS2578.
      expect(lines.filter((line) => line.startsWith(`${FIXTURE}/`))).toEqual(
        [],
      );
    },
  );
});
