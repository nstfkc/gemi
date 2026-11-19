import { existsSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";

/**
 * The files `gemi build` bundles into `dist/server`, relative to the root:
 * `app/server.ts`, which `gemi start` runs as `server.mjs`, and
 * `app/bootstrap.ts` when the app has one, as `bootstrap.mjs`.
 *
 * `bootstrap.mjs` is what a `worker = true` job's thread imports in
 * production when it exists (see `workerEntry` in the queue). No build had
 * emitted it since the server moved to `Bun.build`, so an app whose
 * bootstrap worked under `gemi dev` lost it in production (#1318). An app
 * without one needs nothing: the thread boots from `app/kernel/Kernel.ts`.
 */
export function serverEntrypoints(rootDir: string): string[] {
  const entries = ["./app/server.ts"];
  if (existsSync(path.join(rootDir, "app", "bootstrap.ts"))) entries.push("./app/bootstrap.ts");
  return entries;
}

/**
 * The server half of `gemi build`, after Vite's SSR build: one `Bun.build`
 * of `serverEntrypoints` into `dist/server`, as `[name].mjs`.
 *
 * `packages: "external"` keeps node_modules deps (sharp, prisma's engine,
 * vite/rolldown) resolving at runtime instead of being bundled — bundling them
 * breaks native addons and bloats the output. CSS is loaded as opaque `text` so
 * the bundler neither resolves `url(...)` assets nor leaves a dangling runtime
 * `import` ("Cannot find module ./main.css").
 *
 * The plugins are the custom-request transform plus any app-declared Bun
 * plugins from gemi.config.ts, for controllers/routes that end up bundled into
 * an entry. With `packages: "external"` the app's own code (imported via
 * `@/app/*`) is currently kept external and transformed at runtime by the
 * `--preload` plugin in `start` instead — so these only fire if app code is
 * ever bundled here. Kept as a safety net for that case.
 */
export function buildServerEntries(rootDir: string, plugins: BunPlugin[]) {
  return Bun.build({
    root: rootDir,
    entrypoints: serverEntrypoints(rootDir).map((entry) => path.join(rootDir, entry)),
    outdir: path.join(rootDir, "dist", "server"),
    naming: "[name].mjs",
    target: "bun",
    minify: true,
    // Emit a linked `.map` (with a `sourceMappingURL` comment) so Bun maps
    // production server stack traces back to the app's source.
    sourcemap: "linked",
    plugins,
    packages: "external",
    loader: { ".css": "text" },
  });
}
