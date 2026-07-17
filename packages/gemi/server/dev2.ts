import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";

import { createServer, type ViteDevServer } from "vite";

import { App } from "../app";
import { createDevStyles } from "./styles";

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
}

export async function dev(app: App) {
  // `bun --hot` re-runs this module on every server-code change, so keep a
  // single Vite server on `globalThis` instead of spawning a new one (and a new
  // HMR socket) on each reload.
  const isReload = Boolean(globalThis.__gemiVite);
  const vite = (globalThis.__gemiVite ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  }));

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;

  const server = Bun.serve({
    port: 5173,
    fetch: async (req) => {
      const handler = app.fetch.bind(app);
      const result = (await viteMiddleware(vite, req)) ?? (await handler(req));
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
      if (result instanceof Response) {
        return result;
      } else {
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
          templates.push(template(fileName, `${appDir}/views/${fileName}.tsx`));
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
      }
    },
  });

  // On a reload `app` has already been rebuilt with the new code and Bun.serve
  // above has swapped in the new fetch handler, so the updated controllers are
  // live *now*. Tell the client to re-run its queries only at this point —
  // firing it from Vite's file watcher instead races Bun's reload and leaves
  // the UI one change behind.
  if (isReload) {
    vite.ws.send({ type: "custom", event: "http-reload" });
  }

  return server;
}
