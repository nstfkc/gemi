import { stringEraRefusal } from "../http/Error";
import { join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import type { RunnableDevEnvironment, ViteDevServer } from "vite";

import type { App } from "../app";
import { isApiPath } from "../services/router/apiPath";
import { renderErrorPage } from "./renderErrorPage";
import { createDevStyles } from "./styles";
import type { Instrumentation } from "./types";
import { ISLAND_ENTRY_QUERY } from "../internal/islandRuntime";

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
export function sendErrorToClient(err: any) {
  const vite = globalThis.__gemiVite;
  if (!vite) return;
  vite.ws.send({ type: "error", err: viteErrorPayload(err) as any });
  globalThis.__gemiErrorActive = true;
}

/**
 * The SSR environment's module runner — what `vite.ssrLoadModule` is a thin
 * (and, in Vite 8, deprecated) wrapper over. Going through it directly is what
 * gives `httpDev` a handle on the evaluated-module cache it has to drop after a
 * `bun --hot` reload; `ssrLoadModule` keeps its own runner private.
 *
 * Duck-typed rather than `isRunnableDevEnvironment(environment)`: this server
 * outlives the module instance that created it, and after a reload the freshly
 * evaluated `vite` brings a *new* `RunnableDevEnvironment` class object, so the
 * `instanceof` that predicate performs is false for a perfectly runnable
 * environment. (The same one-copy-per-reload rule this whole dance is about.)
 */
export function ssrRunner(vite: ViteDevServer) {
  const environment = vite.environments.ssr as RunnableDevEnvironment;
  if (typeof environment?.runner?.import !== "function") {
    throw new Error("gemi dev requires a runnable Vite SSR environment.");
  }
  return environment.runner;
}

/**
 * The dev document's single bootstrap module. It loads, in this order:
 *
 *   1. `/refresh.js` — the React Refresh preamble;
 *   2. `/@vite/client` — the HMR client;
 *   3. `/app/client.tsx` — the app.
 *
 * One module, because React emits every `bootstrapModules` entry as
 * `<script type="module" async>`, and async module scripts run in whatever
 * order they finish loading. The preamble has to have installed
 * `window.$RefreshReg$` before any component module evaluates, or
 * `@vitejs/plugin-react`'s transform throws "can't detect preamble" and the
 * app never hydrates. Awaiting each `import()` is what makes the order a
 * guarantee rather than a race.
 *
 * The preamble and the HMR client are each caught: an app without
 * `@vitejs/plugin-react` has no `/@react-refresh` and needs no preamble, and a
 * broken HMR client must not stop the app from booting. The app's own import
 * is not caught, so its errors surface as they would from a script tag.
 */
export const DEV_ENTRY_PATH = "/@gemi/dev-entry.js";

export const DEV_ENTRY_SOURCE = `const report = (error) => console.error(error);
await import("/refresh.js").catch(report);
await import("/@vite/client").catch(report);
await import("/app/client.tsx");
`;

/**
 * Installs the React Refresh preamble, as `@vitejs/plugin-react`'s own
 * `index.html` transform would.
 *
 * The runtime is imported by an origin-relative URL. An absolute one, built
 * from the request URL the server sees, breaks behind a TLS-terminating proxy
 * or tunnel: the browser is on `https://<tunnel>` while the server sees
 * `http://localhost:5173`, so the import is blocked as mixed content or points
 * at a host the browser cannot reach.
 */
export const REFRESH_PREAMBLE_SOURCE = `import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
`;

/**
 * The scripts the dev document loads that nothing on disk backs: the
 * bootstrap entry above, `/refresh.js` with the React Refresh preamble, and
 * `/render-error.js`, which the dev error page loads. `null` for any other
 * path.
 *
 * Answered inside the global middleware, not in front of it as they were. They
 * have no production counterpart, but a gate that must hold in dev as well,
 * one that refuses traffic without a header, is only complete if nothing the
 * dev server answers goes around it.
 */
function devScript(req: Request): Response | null {
  const { pathname } = new URL(req.url);
  const script = (source: string) =>
    new Response(source, {
      headers: {
        "Content-Type": "application/javascript",
      },
    });
  if (pathname === DEV_ENTRY_PATH) {
    return script(DEV_ENTRY_SOURCE);
  }
  if (pathname.startsWith("/render-error.js")) {
    return script("window.render_error = true");
  }
  if (pathname.startsWith("/refresh.js")) {
    return script(REFRESH_PREAMBLE_SOURCE);
  }
  return null;
}

/**
 * The dev server's `fetch` handler, apart from `Bun.serve` and from creating
 * Vite, so a test can hand it a stub Vite server and drive it with plain
 * `Request`s. `httpDev` is the only other caller. This module has no import
 * side effects, unlike `httpDev.ts`, which installs process-wide error hooks.
 */
export function createDevFetch(
  app: App,
  instrumentation: Instrumentation,
  vite: ViteDevServer,
): (req: Request) => Promise<Response> {
  const appDir = join(process.cwd(), "app");

  return async (req) => {
    const { pathname } = new URL(req.url);
    const errorResponse = (err: any): Response => {
      // Errors thrown *while handling a request* (a controller throwing, a
      // failing view import, ...) never hit `httpDev`'s module-load hooks,
      // so surface them here: forward to the overlay for any already-open
      // page, and render an error page for this response so a fresh load
      // (which has no live HMR socket yet) still shows the failure.
      console.error(err);
      vite.ssrFixStacktrace?.(err);
      sendErrorToClient(err);

      if (isApiPath(pathname)) {
        return new Response(
          JSON.stringify({
            error: stringEraRefusal("server_error", err?.message ?? String(err), 500),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // This document has no live app (so no HttpReload listener to clear the
      // overlay) — remember that, so recovery forces a full page reload.
      globalThis.__gemiErrorPageServed = true;
      return new Response(renderErrorPage(viteErrorPayload(err)), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    };
    const requestHandler = async (req: Request): Promise<Response> => {
      const script = devScript(req);
      if (script) {
        return script;
      }
      try {
        const handler = app.fetch.bind(app);
        const result = (await viteMiddleware(vite, req)) ?? (await handler(req));
        if (result instanceof Response) {
          return result;
        }

        const viewImportMap = {};
        const ogMap = {};
        const viewModules = {};
        const template = (viewName: string, path: string) =>
          `"${viewName}": () => import("${path}")`;
        const templates = [];

        for (const fileName of ["404", ...app.getFlatComponentTree.call(app)]) {
          if (process.env.NODE_ENV === "test") {
            break;
          }
          const appDir = `${process.env.APP_DIR}`;
          const mod = await ssrRunner(vite).import(`${appDir}/views/${fileName}.tsx`);

          viewImportMap[fileName] = mod.default;
          ogMap[fileName] = mod?.OpenGraph;
          // The whole module, so a streaming render can put the view's
          // `Loading`/`Error` exports into the shell it sends.
          viewModules[fileName] = mod;
          // Emit a root-relative URL (`/app/views/Foo.tsx`), NOT the absolute
          // filesystem path the runner import above uses. The browser's
          // `window.loaders` preload and `client.tsx`'s `import.meta.glob` map
          // must import the exact same URL — otherwise Vite serves the module
          // under two URLs (`/app/views/Foo.tsx` vs `/Users/.../app/views/Foo.tsx`)
          // and loads/instantiates the view twice.
          templates.push(template(fileName, `/app/views/${fileName}.tsx`));
        }

        const loaders = `{${templates.join(",")}}`;

        return await result({
          getStyles: async (currentViews: string[], options?: { static?: boolean; layout?: string }) =>
            await createDevStyles(appDir, vite, currentViews, options?.layout),
          // Vite serves app files by their root-relative path; the island
          // entry is that path plus the plugin's query.
          resolveIsland: (moduleKey: string) => ({
            src: `/${moduleKey}${ISLAND_ENTRY_QUERY}`,
            preload: [],
          }),
          // Vite serves modules fresh, so dev has one build.
          buildId: "dev",
          bootstrapModules: [DEV_ENTRY_PATH],
          viewImportMap,
          viewModules,
          ogMap,
          loaders,
          cssManifest: {},
        });
      } catch (err: any) {
        return errorResponse(err);
      }
    };

    // In front of Vite's middleware, the dev scripts and the app, as
    // `httpProd` puts the global middleware in front of its static files, so a
    // check that passes here passes there. A throw from it is answered like
    // one from a route. Vite's HMR websocket is the one thing it cannot cover:
    // its upgrade is relayed to Vite by `Bun.serve` (see `hmrRelay.ts`) before
    // this handler runs, and Vite checks the token and host itself.
    return await instrumentation(req, (req) =>
      app.withGlobalMiddleware(req, requestHandler, errorResponse),
    );
  };
}
