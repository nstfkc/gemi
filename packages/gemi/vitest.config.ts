import { configDefaults, defineConfig } from "vitest/config";

/**
 * The package had no vitest config, and this exists to hold back exactly one
 * file.
 *
 * `packaging.test.ts` runs `bun run build:publish`, which deletes and recreates
 * `dist/`. That is fine for the test and bad for its neighbours: CI runs the
 * unit suite *before* the steps that shell out to `dist/bin/gemi.js`, so a build
 * that fails for a reason unrelated to packaging leaves those steps reporting a
 * missing module and the real cause buried in a `beforeAll` stack. It also puts
 * a full framework build in parallel with the timing-sensitive ORM suites.
 *
 * So it runs on its own, last, through `vitest.packaging.config.ts` — see the
 * `test:packaging` script and the CI step that calls it. Held out by name
 * rather than by a pattern: a pattern is how a file stops running without
 * anyone noticing, which is the failure this repository's CI comments spend
 * several paragraphs on.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "packaging.test.ts"],
  },
});
