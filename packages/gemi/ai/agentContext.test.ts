import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `AgentContext` is required exactly when the app declared something required.
 *
 * THE CLAIM THIS HOLDS DOWN is the one `ContextParam` exists for: an app that
 * adds a field to `AgentContext` is shown every run that now has to supply it,
 * rather than finding out from a tool that read `undefined`. Measured — with
 * `ContextParam` flattened to `{ context?: AgentContext }`, the whole unit
 * suite and all 114 type tests still pass. The behaviour was held down by
 * nothing, in the module whose own `ToolShapesOf` docblock records two prior
 * inference regressions.
 *
 * NOT A `*.test-d.ts`, and that is the reason this file spawns a compiler.
 * `vitest --typecheck` compiles every `*.test-d.ts` into ONE program, so a
 * `declare module "gemi/ai"` in any of them would augment `AgentContext` for
 * all of them — and the two cases here are contradictory by construction: one
 * app declares a required field, the other does not. They have to be separate
 * programs, so each fixture gets its own `tsconfig`.
 *
 * The fixtures import through `gemi/ai` rather than a relative path, because
 * the specifier is part of what is being tested: an app writes
 * `declare module "gemi/ai"`, and that only reaches the interface because
 * `ai/index.ts` re-exports it. A relative import would pass while the public
 * augmentation was broken.
 */

const PACKAGE = path.join(import.meta.dirname, "..");
const TSC = path.join(PACKAGE, "node_modules", ".bin", "tsc");
const FIXTURES = "ai/__fixtures__/agent-context";

function compile(fixture: "required" | "optional"): string[] {
  const result = Bun.spawnSync([TSC, "--noEmit", "-p", `${FIXTURES}/tsconfig.${fixture}.json`], {
    cwd: PACKAGE,
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("error TS"));
}

describe("the app's AgentContext decides whether `context` may be omitted", () => {
  test(
    "a required field makes `agent.stream()` refuse to compile without one",
    { timeout: 60_000 },
    () => {
      const errors = compile("required");

      // One error, and it has to be THE error. Asserting only on the count would
      // pass on a fixture that stopped compiling for an unrelated reason — which
      // is the way a spawn-a-compiler test usually rots.
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("required.ts(24,14)");
      expect(errors[0]).toContain("TS2345");

      // The call on the next line passes a context and must be fine, so the
      // single error above is also what says the positive case still compiles.
    },
  );

  test("with nothing required, `context` stays optional", { timeout: 60_000 }, () => {
    // The other half, and not merely the negation: an app that never declares a
    // context must not be made to write `context: {}` at every call site. If
    // `ContextParam` resolved to the required branch for `{}`, every existing
    // app would stop compiling on upgrade.
    expect(compile("optional")).toEqual([]);
  });
});
