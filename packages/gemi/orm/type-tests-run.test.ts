import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The template's type assertions are actually executed by something.
 *
 * `wrap.test-d.ts` and `aggregate.test-d.ts` hold 15 assertions — and ran
 * nowhere. Vitest's default `include` is `**‍/*.test.ts`, which `.test-d.ts`
 * does not match, so `vitest run app/models` collected none of them; there was
 * no `--typecheck` invocation in any script or in CI. `vitest list app/models`
 * reported 0 of them, and `--typecheck` reported 15.
 *
 * They are the only check on the compile-time half of the ORM's pitch. The
 * runtime suite cannot express what they assert:
 *
 *     // @ts-expect-error a partial row is missing columns a method could read
 *     UserModel.wrap(partial);
 *
 * which is the claim `docs/orm-rows-and-entities.md` makes in as many words —
 * "`wrap` requires a **complete** row. A partial one is a compile error" — and
 * the reason the page gives for why narrowing and behaviour can coexist at all.
 *
 * `@ts-expect-error` fails when the error it expects stops happening, so these
 * are load-bearing rather than decorative: making `wrap` accept what it should
 * refuse turns the directive into `Unused '@ts-expect-error' directive`. That
 * was checked rather than assumed.
 *
 * This guards the wiring, not the assertions — the failure was that nothing ran
 * them, and nothing would have noticed if the step were deleted again.
 */
const ROOT = join(import.meta.dirname, "../../..");

const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const templatePackage = JSON.parse(
  readFileSync(join(ROOT, "templates/saas-starter/package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("the template's type tests are wired to something that runs them", () => {
  test("the template has a script that runs vitest in typecheck mode", () => {
    const script = templatePackage.scripts?.["test:types"];
    expect(script, "templates/saas-starter has no test:types script").toBeDefined();
    expect(script).toContain("--typecheck");
  });

  /**
   * The template's own app code has type errors unrelated to the ORM, so a
   * plain typecheck run fails on them and the step would have to be removed
   * again. Pinned so the reason survives: without this flag the assertions
   * cannot be run at all.
   */
  test("it reports only the assertions, not the template's unrelated errors", () => {
    expect(templatePackage.scripts?.["test:types"]).toContain("ignoreSourceErrors");
  });

  test("CI runs it", () => {
    expect(
      workflow,
      "no CI step invokes the template's type tests, so they run nowhere again",
    ).toContain("bun run test:types");
  });

  /**
   * The files it exists to run. If both are deleted the script passes over an
   * empty set, which is the same silence this whole test exists to break.
   */
  test.each(["wrap.test-d.ts", "aggregate.test-d.ts"])("%s is still there", (file) => {
    const source = readFileSync(
      join(ROOT, "templates/saas-starter/app/models", file),
      "utf8",
    );
    expect(source).toContain("@ts-expect-error");
  });
});
