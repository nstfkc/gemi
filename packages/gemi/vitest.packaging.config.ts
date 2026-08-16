import { defineConfig } from "vitest/config";

/**
 * The packaging test on its own — see `vitest.config.ts` for why it is held out
 * of the default run, and `packaging.test.ts` for what it covers.
 *
 * `testTimeout` and `hookTimeout` are generous because the `beforeAll` builds
 * the package, packs it and runs `tsc` over a fixture: about eight seconds
 * locally, and a cold CI runner is slower.
 */
export default defineConfig({
  test: {
    include: ["packaging.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
