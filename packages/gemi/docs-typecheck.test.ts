import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

/**
 * The docs' complete examples compile, under `strict` (#1007).
 *
 * `docs-imports.test.ts` checks that what a page imports exists; that does
 * not catch an example that imports the right names and then fails to
 * typecheck, which is how a judge in `docs/ai-evals.md` shipped broken for
 * every strict app. So the complete examples of the pages below are compiled
 * as an app would compile them: `strict`, through `gemi/ai`'s source.
 *
 * A complete example is a ```ts block that starts with an `import` (after an
 * optional `// path` comment line); a fragment (one option, an object in
 * isolation) can't compile on its own and is left out. What the examples
 * import from an app (`@/app/config/ai`, `./helpers`) is stubbed in
 * `ai/__fixtures__/docs/`.
 */
const PACKAGE = import.meta.dirname;
const DOCS = path.join(PACKAGE, "../../docs");
const FIXTURE = path.join(PACKAGE, "ai/__fixtures__/docs");
const PAGES = ["ai-evals.md", "ai-usage.md"];

function examples(page: string): string[] {
  const text = readFileSync(path.join(DOCS, page), "utf8");
  return [...text.matchAll(/^```ts\n([\s\S]*?)^```$/gm)]
    .map((match) => match[1]!)
    .filter((code) => /^(\/\/[^\n]*\n)?import /.test(code));
}

function clean() {
  for (const file of readdirSync(FIXTURE)) {
    if (file.startsWith("generated-")) rmSync(path.join(FIXTURE, file));
  }
}

afterAll(clean);

test("the pages have complete examples to check", () => {
  for (const page of PAGES) expect(examples(page).length, page).toBeGreaterThan(0);
});

test("the docs' complete examples compile under strict", { timeout: 120_000 }, () => {
  clean();
  for (const page of PAGES) {
    examples(page).forEach((code, at) => {
      // `export {}` makes each a module, so top-level names don't collide.
      writeFileSync(
        path.join(FIXTURE, `generated-${page.replace(/\W/g, "-")}-${at + 1}.ts`),
        `${code}\nexport {};\n`,
      );
    });
  }
  const result = Bun.spawnSync(
    [
      path.join(PACKAGE, "node_modules", ".bin", "tsc"),
      "--noEmit",
      "-p",
      "ai/__fixtures__/docs/tsconfig.json",
    ],
    { cwd: PACKAGE },
  );
  // Only the fixture's errors: the framework's own source is not written for
  // `strict` (an app compiles its declarations, not its source).
  const errors = `${result.stdout.toString()}${result.stderr.toString()}`
    .split("\n")
    .filter((line) => line.includes("error TS") && line.includes("__fixtures__/docs/"));
  expect(errors).toEqual([]);
});
