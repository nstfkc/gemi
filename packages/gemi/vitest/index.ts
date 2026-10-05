import type { Plugin } from "vite";
import {
  CUSTOM_REQUEST_FILTER,
  customRequestParser,
} from "../bun/customRequestParser";

/**
 * The request-param rewrite, as a Vite plugin, for running an app's routes
 * under vitest.
 *
 * gemi calls a route handler and a controller method with no arguments, and a
 * handler written `async (req: HttpRequest<…>) => …` only gets its request
 * because the build rewrites it to `async (req = new HttpRequest()) => …`, which
 * reads the current request from the request context. The app's build and dev
 * server get that rewrite from `gemi/bun/plugin`. Vitest loads modules through
 * Vite instead, even under `bun --bun vitest`, so without this plugin a route
 * dispatched with `App.fetch` in a test sees `req === undefined`.
 *
 * Same transform, same files (`/http/controllers/` and `/http/routes/`) as the
 * Bun plugin. `enforce: "pre"` so it sees the TypeScript annotations before
 * Vite strips them.
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { gemiRequestPlugin } from "gemi/vitest";
 *
 * export default defineConfig({ plugins: [gemiRequestPlugin()] });
 * ```
 */
export function gemiRequestPlugin(): Plugin {
  return {
    name: "gemi-custom-request",
    enforce: "pre",
    async transform(code, id) {
      const path = id.split("?", 1)[0];
      if (path.includes("/node_modules/") || !CUSTOM_REQUEST_FILTER.test(path)) {
        return null;
      }
      return { code: await customRequestParser(code), map: null };
    },
  };
}

/**
 * gemi's island transform, for an app's `vitest.config.ts`: with it, a test
 * that renders a static view through `App.fetch` sees each
 * `island(() => import("./Counter"))` with the same module key as the build,
 * and a hydrated view renders the component in place instead of lazily.
 *
 * Without it islands still render (the component is loaded with the
 * `import()`), but their keys are unknown.
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { gemiIslandPlugin, gemiRequestPlugin } from "gemi/vitest";
 *
 * export default defineConfig({ plugins: [gemiRequestPlugin(), gemiIslandPlugin()] });
 * ```
 */
export { gemiIslandPlugin } from "../vite/islandPlugin";
