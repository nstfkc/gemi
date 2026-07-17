import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";

import { createServer, type ViteDevServer } from "vite";

import { App } from "../app";
import { createDevStyles } from "./styles";
import { renderErrorPage } from "./renderErrorPage";
import { Instrumentation } from "./types";
import { printStartupBanner } from "./banner";

// Run a Web `Request` through Vite's Connect middleware.
// Resolves to a `Response` when Vite handles the request (module transforms,
// assets, the HMR client, ...), or `null` when it calls `next()` — which, with
// `appType: "custom"`, it does for everything it doesn't own.
function viteMiddleware(vite: ViteDevServer, request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  const req = new IncomingMessage(new Socket());
  req.url = url.pathname + url.search;
  req.method = request.method;
  req.headers = Object.fromEntries(request.headers);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];

  return new Promise((resolve) => {
    res.write = ((chunk: any) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: any) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk));

      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        if (value == null) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          headers.append(key, String(v));
        }
      }

      resolve(
        new Response(chunks.length ? Buffer.concat(chunks) : null, {
          status: res.statusCode,
          headers,
        }),
      );
      return res;
    }) as typeof res.end;

    vite.middlewares(req, res, () => resolve(null));
  });
}

const rootDir = process.cwd();
const appDir = join(rootDir, "app");

declare global {
  // Created once and reused across `bun --hot` reloads (see below).
  var __gemiVite: ViteDevServer | undefined;
  // Guards one-time registration of the process error hooks across reloads.
  var __gemiErrorHooked: boolean | undefined;
  // An error overlay is currently showing on the client (clear it on recovery).
  var __gemiErrorActive: boolean | undefined;
  // We served a standalone error *page* (not just a pushed overlay), so the
  // visible document has no live app — recovery needs a full page reload.
  var __gemiErrorPageServed: boolean | undefined;
}

// Build the `>  1 | ...\n     |     ^` codeframe Vite's overlay renders — must
// match its `codeframeRE` (a `<line> | <text>` line followed by a `| ^` line,
// each ending in a newline).
function codeFrame(lineText: string, line: number, column: number) {
  const gutter = String(line);
  const pad = " ".repeat(gutter.length);
  const caret = " ".repeat(Math.max(0, column - 1)) + "^";
  return `${gutter} |  ${lineText}\n${pad} |  ${caret}\n`;
}

// Normalize whatever Bun/JS throws into the { message, stack, frame, loc }
// shape Vite's error overlay consumes. Two cases matter:
//   - a real `Error` (runtime top-level throw) carries a proper `.stack`;
//   - a Bun `BuildMessage` (syntax error) has NO `.stack`, only a `.position`
//     ({ file, line, column, lineText }) — so synthesize a codeframe + loc from
//     it, otherwise the overlay shows a bare message with no location.
// (An `Error` instance also JSON-stringifies to `{}`, so fields are copied by
// hand either way.)
export function viteErrorPayload(err: any) {
  if (err && typeof err === "object") {
    const pos = err.position;
    if (pos && typeof pos === "object" && typeof pos.file === "string") {
      return {
        message: typeof err.message === "string" ? err.message : String(err),
        stack: "",
        frame:
          typeof pos.lineText === "string"
            ? codeFrame(pos.lineText, pos.line, pos.column)
            : undefined,
        loc: { file: pos.file, line: pos.line, column: pos.column },
      };
    }
    return {
      message: typeof err.message === "string" ? err.message : String(err),
      stack: typeof err.stack === "string" ? err.stack : "",
    };
  }
  return { message: String(err), stack: "" };
}

// Push an error into the browser via Vite's HMR socket. `__gemiVite` persists
// across `bun --hot` reloads, so this works even when the reload that produced
// the error never got far enough to (re)run `httpDev`.
function sendErrorToClient(err: any) {
  const vite = globalThis.__gemiVite;
  if (!vite) return;
  vite.ws.send({ type: "error", err: viteErrorPayload(err) as any });
  globalThis.__gemiErrorActive = true;
}

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
    server: {
      middlewareMode: true,
      // gemi reloads `.env` into process.env itself (see `watchEnv`). Stop Vite
      // from *also* watching env files: Vite's env-change handler restarts the
      // dev server, which closes the SSR module runner — but gemi keeps a single
      // Vite instance across `bun --hot` reloads, so an in-flight `ssrLoadModule`
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
    // (react-dom/server in ViewRouterServiceContainer) is imported by Bun.
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
    // a view might import must be listed.
    ssr: {
      external: [
        "gemi",
        "gemi/client",
        "gemi/http",
        "gemi/app",
        "gemi/facades",
        "gemi/email",
        "gemi/runtime",
        "gemi/kernel",
        "gemi/services",
        "gemi/broadcasting",
        "gemi/i18n",
      ],
    },
  }));

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;

  const server = Bun.serve({
    port: 5173,
    fetch: async (req) => {
      const { pathname, host, protocol } = new URL(req.url);
      if (pathname.startsWith("/render-error.js")) {
        return new Response("window.render_error = true", {
          headers: {
            "Content-Type": "application/javascript",
          },
        });
      }
      if (pathname.startsWith("/refresh.js")) {
        return new Response(
          `
          import RefreshRuntime from "${protocol}//${host}/@react-refresh";
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => (type) => type;
          window.__vite_plugin_react_preamble_installed__ = true;
        `,
          {
            headers: {
              "Content-Type": "application/javascript",
            },
          },
        );
      }
      const requestHandler = async (req: Request): Promise<Response> => {
        try {
          const handler = app.fetch.bind(app);
          const result = (await viteMiddleware(vite, req)) ?? (await handler(req));
          if (result instanceof Response) {
            return result;
          }

          const viewImportMap = {};
          const ogMap = {};
          const template = (viewName: string, path: string) =>
            `"${viewName}": () => import("${path}")`;
          const templates = [];

          for (const fileName of ["404", ...app.getFlatComponentTree.call(app)]) {
            if (process.env.NODE_ENV === "test") {
              break;
            }
            const appDir = `${process.env.APP_DIR}`;
            const mod = await vite.ssrLoadModule(`${appDir}/views/${fileName}.tsx`, {
              fixStacktrace: true,
            });

            viewImportMap[fileName] = mod.default;
            ogMap[fileName] = mod?.OpenGraph;
            // Emit a root-relative URL (`/app/views/Foo.tsx`), NOT the absolute
            // filesystem path used for `ssrLoadModule` above. The browser's
            // `window.loaders` preload and `client.tsx`'s `import.meta.glob` map
            // must import the exact same URL — otherwise Vite serves the module
            // under two URLs (`/app/views/Foo.tsx` vs `/Users/.../app/views/Foo.tsx`)
            // and loads/instantiates the view twice.
            templates.push(template(fileName, `/app/views/${fileName}.tsx`));
          }

          const loaders = `{${templates.join(",")}}`;

          return await result({
            getStyles: async (currentViews: string[]) =>
              await createDevStyles(appDir, vite, currentViews),
            bootstrapModules: ["/refresh.js", "/app/client.tsx", "/@vite/client"],
            viewImportMap,
            ogMap,
            loaders,
            cssManifest: {},
          });
        } catch (err: any) {
          // Errors thrown *while handling a request* (a controller throwing, a
          // failing `ssrLoadModule`, ...) never hit the module-load hooks above,
          // so surface them here: forward to the overlay for any already-open
          // page, and render an error page for this response so a fresh load
          // (which has no live HMR socket yet) still shows the failure.
          console.error(err);
          vite.ssrFixStacktrace?.(err);
          sendErrorToClient(err);

          if (pathname.startsWith("/api")) {
            return new Response(JSON.stringify({ error: err?.message ?? String(err) }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          // This document has no live app (so no HttpReload listener to clear the
          // overlay) — remember that, so recovery forces a full page reload.
          globalThis.__gemiErrorPageServed = true;
          return new Response(renderErrorPage(viteErrorPayload(err)), {
            status: 500,
            headers: { "Content-Type": "text/html" },
          });
        }
      };

      return await instrumentation(req, requestHandler);
    },
  });

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
