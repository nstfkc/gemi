import { join } from "node:path";

import { createServer } from "vite";

import { App } from "../app";
import gemiVite from "../vite";
import { Instrumentation } from "./types";
import { printStartupBanner } from "./banner";
import { GEMI_EXTERNAL_SPECIFIERS } from "../internal/gemiExternals";
import { createDevFetch, sendErrorToClient, ssrRunner } from "./devFetch";

export { viteErrorPayload } from "./devFetch";

const rootDir = process.cwd();
const appDir = join(rootDir, "app");

// `bun --hot` re-evaluates the module graph on every server-code change. A
// syntax error or top-level throw in app code therefore fails during *module
// load* — outside any request, and before `httpDev` re-runs — so Bun only
// prints it to the console. Bun surfaces these as `unhandledRejection` (the
// reload re-imports the entry and the failing dynamic import rejects), so hook
// that here and forward it to the client. Registered once; process listeners
// persist across reloads.
if (!globalThis.__gemiErrorHooked) {
  globalThis.__gemiErrorHooked = true;
  process.on("unhandledRejection", (reason) => {
    console.error(reason);
    sendErrorToClient(reason);
  });
  process.on("uncaughtException", (err) => {
    console.error(err);
    sendErrorToClient(err);
  });
}

export async function httpDev(app: App, instrumentation: Instrumentation) {
  // `bun --hot` re-runs this module on every server-code change, so keep a
  // single Vite server on `globalThis` instead of spawning a new one (and a new
  // HMR socket) on each reload.
  const isReload = Boolean(globalThis.__gemiVite);
  const vite = (globalThis.__gemiVite ??= await createServer({
    // gemi owns the Vite setup — the app has no `vite.config.mjs` to discover.
    // Register the gemi plugin explicitly instead; it loads `gemi.config.ts` and
    // appends the app's Vite plugins (e.g. `@vitejs/plugin-react`, which serves
    // `/@react-refresh` and the HMR preamble referenced below).
    configFile: false,
    plugins: [gemiVite()],
    server: {
      middlewareMode: true,
      // Vite answers any host other than `localhost` and `*.localhost` with a
      // 403, which would block a `route.domains` root such as `lvh.me` and
      // every custom domain pointed here from `/etc/hosts`.
      allowedHosts: app.devAllowedHosts.call(app),
      // gemi reloads `.env` into process.env itself (see `watchEnv`). Stop Vite
      // from *also* watching env files: Vite's env-change handler restarts the
      // dev server, which closes the SSR module runner — but gemi keeps a single
      // Vite instance across `bun --hot` reloads, so an in-flight view import
      // hits the closed runner ("Vite module runner has been closed"). Ignoring
      // env files here only disables the restart; env *loading* at startup (and
      // `import.meta.env`) is unaffected.
      watch: {
        ignored: (file: string) => {
          const base = file.split(/[/\\]/).pop() ?? "";
          return base === ".env" || base.startsWith(".env.");
        },
      },
    },
    appType: "custom",
    // Views are loaded through this SSR graph while the renderer
    // (react-dom/server in ViewRouteDispatcher) is imported by Bun.
    // Dedupe so Vite can never resolve a second React copy — a mismatch makes
    // the SSR dispatcher null ("Invalid hook call") after an HMR reload.
    resolve: { dedupe: ["react", "react-dom"] },
    // Pre-bundle the whole React surface the client uses in one pass. The client
    // imports `react-dom/client` (`init.tsx`) and `react-dom` (`createPortal` in
    // `HttpReload.tsx`); if only the first is discovered at startup, the first
    // request to a module using the second triggers a *second* optimize pass,
    // and the already-served page ends up importing a now-stale dep — surfacing
    // as "does not provide an export named 't'". Listing them up front bundles
    // them together so no re-optimization (and no version skew) happens.
    optimizeDeps: { include: ["react", "react-dom", "react-dom/client"] },
    // `gemi` is a linked package, so Vite would otherwise compile its own copy
    // into this graph — giving views a *different* `RouteStateContext` (and
    // other module-level singletons) than the Bun-loaded renderer's `Root`
    // provider, so `useRouteData()` reads the empty default (`i18n` undefined).
    // Externalizing makes view imports of `gemi/*` resolve to the one Bun
    // instance. Vite's `ssr.external` matches exact specifiers (subpaths are NOT
    // covered by the bare name, and regexes are ignored here), so every subpath
    // a view might import must be listed — see `internal/gemiExternals`, the
    // shared source of truth this and the SSR build (`vite/index.ts`) both use.
    ssr: {
      external: [...GEMI_EXTERNAL_SPECIFIERS],
    },
  }));

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;

  const server = Bun.serve({
    // Same override the prod server honors (`httpProd.ts`).
    port: process.env.PORT || 5173,
    fetch: createDevFetch(app, instrumentation, vite),
  });

  // `bun --hot` re-evaluates its *whole* module graph on a server-code change —
  // node_modules included — so after a reload `react`, `react-dom/server` and the
  // Bun-loaded `gemi` are all fresh instances. This Vite server is not reloaded
  // with them (it is deliberately kept on `globalThis` above), and its SSR runner
  // still holds every view module it has evaluated — each bound, through the
  // externalized `gemi/*` imports, to the *previous* `gemi` and therefore the
  // previous `react`. The next render then sets the dispatcher on the new React
  // while a cached view calls hooks on the old one: "Invalid hook call", a null
  // `dispatcher.useContext` thrown from `useRouteData` inside a view nobody
  // touched. Editing a *view* never showed it — Vite's own watcher invalidates
  // that module, so it re-evaluates against the new instances. Editing a
  // server-only file (`app/config/*`, a feature declaration, a controller) is
  // the case with nothing to invalidate the views, so drop the evaluated
  // modules here, once per reload.
  //
  // Here and not before `Bun.serve`, with nothing awaited in between, because
  // both sides of the swap have to see a consistent pair. Until that call
  // returns the *previous* fetch handler is still serving — old dispatcher, old
  // `react-dom/server` — and a request landing there after an early clear would
  // re-evaluate its views against the *new* `gemi`: the same mismatch, reversed.
  // After it, the new handler is live and must not be given the stale ones. The
  // two statements are synchronous neighbours, so no request can be dispatched
  // between them.
  //
  // Only the *evaluated* modules go: the server-side transform cache is
  // untouched, so this costs a re-evaluation and not a re-transform. Clearing
  // the module graph as well would not have been enough anyway — externalized
  // deps (`gemi`, and React through it) are cached in the runner by URL and
  // carry no invalidation flag, which is exactly where the stale React hides.
  if (isReload) {
    ssrRunner(vite).clearCache();
  }

  // On a reload `app` has already been rebuilt with the new code and Bun.serve
  // above has swapped in the new fetch handler, so the updated controllers are
  // live *now*. Tell the client to re-run its queries only at this point —
  // firing it from Vite's file watcher instead races Bun's reload and leaves
  // the UI one change behind.
  if (isReload) {
    // We got here, so the reload succeeded. Recover from any error that was
    // showing: a standalone error page must be fully reloaded to get the app
    // back, whereas an overlay pushed onto a live page is cleared by the
    // client's `http-reload` handler (no jarring full-page reload). A normal
    // reload just re-runs client queries against the now-live controllers.
    if (globalThis.__gemiErrorActive && globalThis.__gemiErrorPageServed) {
      globalThis.__gemiErrorActive = false;
      globalThis.__gemiErrorPageServed = false;
      vite.ws.send({ type: "full-reload" });
    } else {
      globalThis.__gemiErrorActive = false;
      vite.ws.send({ type: "custom", event: "http-reload" });
    }
  } else {
    // First start (not a `bun --hot` reload) — print the startup banner once.
    printStartupBanner({ port: server.port, rootDir });
  }

  return server;
}
