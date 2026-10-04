import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `fromApiRoute` compiled the way an app compiles it: `strict: true` (#769).
 *
 * The package itself compiles with `strict: false`, and so does every
 * `*.test-d.ts`. Under `strictFunctionTypes` `DataOf` once matched no route at
 * all — it inferred through `ApiRouterHandler`'s `__error?: [Error]`
 * parameter, which is checked contravariantly, and `[any]` is not assignable
 * to `[never]` — so every `result` was handed `unknown` while
 * `McpRouter.test-d.ts` stayed green. Hence a separate program, with its own
 * `tsconfig`.
 *
 * Only diagnostics in the fixture count. gemi's own sources do not compile
 * under `strict`, and an app never sees that: it reads gemi's declarations with
 * `skipLibCheck`. What it does see is what the fixture sees.
 */

const PACKAGE = path.join(import.meta.dirname, "..");
const TSC = path.join(PACKAGE, "node_modules", ".bin", "tsc");
const FIXTURE = "http/__fixtures__/mcp-strict";

describe("fromApiRoute under strict: true", () => {
  test(
    "result is handed each route's answer, and output and input are still checked",
    { timeout: 60_000 },
    () => {
      const result = Bun.spawnSync([TSC, "--noEmit", "-p", `${FIXTURE}/tsconfig.json`], {
        cwd: PACKAGE,
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      const lines = output.split("\n").map((line) => line.trim());

      // The fixture has to have been compiled at all: a tsconfig that stopped
      // finding it would leave nothing to report and pass vacuously.
      expect(output).not.toContain("TS18003");
      expect(output).not.toContain("TS5083");

      // Its `@ts-expect-error`s are part of this: an unused one is TS2578.
      expect(lines.filter((line) => line.startsWith(`${FIXTURE}/`))).toEqual([]);
    },
  );
});
