import { join, resolve, sep } from "node:path";
import { compressResponse } from "./compression";
import { generateETag } from "./generateEtag";
import { URLPattern } from "urlpattern-polyfill";
import { stat } from "node:fs/promises";
import { createStyles } from "./styles";
import { CLIENT_ENTRY_KEY, collectModulePreloads, createClientEntry } from "./modulePreloads";
import type { App } from "../app";
import { Instrumentation } from "./types";
import { printStartupBanner } from "./banner";
import { isReservedAssetPath, staticAssetMiss } from "./staticAssetMiss";
import { assetUrl, readBuiltAssetBase } from "../config/assetBase";
import { isApiPath } from "../services/router/apiPath";
import { projectRoot } from "../support/discover";
import { unhandledErrorResponse } from "./unhandledError";

// The rule this file used to spell out itself. It moved to `projectRoot`
// because discovery needs the same answer during `waitForBoot()`, which is
// before `ROOT_DIR` below exists — and two spellings of "where is the project"
// is how a job gets looked for in one directory and served from another.
const rootDir = projectRoot();

const appDir = join(rootDir, "app");
const distDir = join(rootDir, "dist");

const clientDir = join(distDir, "client");

// The file in `dist/client` a static-looking pathname names, or `null` when
// it names nothing there. The pathname is still percent-encoded, and Vite
// writes files whose names need encoding (a public `my font.woff2`), so it is
// decoded first. Decoding also turns `%2F` into a separator, which the URL
// parser's own `..` normalization never saw — so the resolved path is checked
// to still be inside `dist/client`. A malformed escape is a miss, not a 500.
function clientFilePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = resolve(clientDir, "." + decoded.replace("/assets/assets", "/assets"));
  return path.startsWith(clientDir + sep) ? path : null;
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// `app` is built by `Server.start` (from the kernel) and passed in — same as
// `httpDev` — so prod and dev share one construction path. What differs here is
// that views/styles are served from the built `dist/` manifests instead of
// Vite's dev SSR graph.
export async function httpProd(app: App, instrumentation: Instrumentation) {
  const manifest = await import(`${distDir}/client/.vite/manifest.json`);
  const serverManifest = await import(`${distDir}/server/.vite/manifest.json`);
  // What the client build was built with, not `GEMI_ASSET_BASE` as it reads
  // now — see `readBuiltAssetBase`. Every URL below that names a chunk goes
  // through it, so the document links exactly what the bundle imports.
  const assetBase = await readBuiltAssetBase(`${distDir}/client`);

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;
  process.env.DIST_DIR = distDir;

  const viewImportMap = {};
  const ogMap = {};
  const viewModules = {};
  const cssManifest = {};
  // Which chunks a route's views pull in, so the shell can preload the chain
  // the client would otherwise discover one round trip at a time (#352).
  const modulePreloadManifest: Record<string, string[]> = {};
  const template = (viewName: string, path: string) => `"${viewName}": () => import("${path}")`;
  const templates = [];

  for (const fileName of ["404", ...app.getFlatComponentTree.call(app)]) {
    const serverFile = serverManifest[`app/views/${fileName}.tsx`];
    if (!serverFile?.file) {
      console.log(`Server file not found for ${fileName}`);
      console.log(serverFile);
      const files = Object.keys(serverManifest);
      const path = `app/views/${fileName}.tsx`;
      console.log(`${path} not found in server manifest`);
      console.log(files);
    }
    const mod = await import(`${process.env.DIST_DIR}/server/${serverFile?.file}`);
    viewImportMap[fileName] = mod.default;
    ogMap[fileName] = mod.OpenGraph;
    // The whole module, so a streaming render can put the view's
    // `Loading`/`Error` exports into the shell it sends.
    viewModules[fileName] = mod;
    const clientFile = manifest[`app/views/${fileName}.tsx`];

    if (clientFile?.css && clientFile?.css.length > 0) {
      cssManifest[fileName] = clientFile?.css;
    }
    if (clientFile) {
      templates.push(template(fileName, assetUrl(clientFile?.file, assetBase)));
      modulePreloadManifest[fileName] = collectModulePreloads(
        manifest,
        `app/views/${fileName}.tsx`,
        assetBase,
      );
    }
  }

  const loaders = `{${templates.join(",")}}`;

  // Booted from the bootstrap script rather than through React's
  // `bootstrapModules`, which would preload it at `fetchPriority="low"` — see
  // `clientEntry` in `ViewRouteDispatcher`.
  const clientEntry = createClientEntry(manifest, assetBase);
  if (!clientEntry) {
    // Loudly, but without dying: this is boot, and an incomplete `dist/` must
    // not cost the API routes and static assets too.
    console.error(
      `Client manifest has no "${CLIENT_ENTRY_KEY}" entry — dist/client is incomplete, so documents will render but never hydrate.`,
    );
  }

  // Vite's manifest `css` field is a `string[]` — a client entry can emit more
  // than one CSS chunk. Read and concatenate them all instead of interpolating
  // the array into a single path (which only works for a one-element array).
  const appCssFiles: string[] = manifest["app/client.tsx"]?.css ?? [];
  const appCSSContent = (
    await Promise.all(appCssFiles.map((cssFile) => Bun.file(`${distDir}/client/${cssFile}`).text()))
  ).join("\n");

  // Which requests are answered from `dist/client` rather than the app:
  //
  // - `/assets` and everything under it, whatever the extension. Vite writes
  //   fonts, GIFs, video and `?url` JSON there too, and an allowlist of
  //   extensions always trailed the build — a `.woff2` went to the router
  //   and paid for an SSR attempt. The router refuses routes under `/assets`
  //   at boot, so there is no app answer to lose, and `staticAssetMiss`
  //   turns a miss into the reload stub or a 404.
  // - `/.well-known/*`.
  // - A root-level public file (`/favicon.ico`, `/robots.txt`, …), known only
  //   by its extension, since any other path may be an app route. A miss
  //   there goes to the app. `json` is left out on purpose: a client-side
  //   navigation fetches a view's data as `/<path>.json`, so matching it would
  //   put a filesystem lookup in front of every navigation and let a public
  //   file shadow a view's data. `mjs` is here because a build configured to
  //   emit `.mjs` chunks is served the same way as `.js`.
  // - `/manifest.json`, the one root-level JSON file an app is expected to
  //   ship (a PWA manifest in `public/`). Only when the file exists: a miss
  //   goes to the app, so a view at `/manifest` keeps its data URL unless the
  //   app also ships the file — and then the file wins.
  const publicFilePattern = new URLPattern({
    pathname:
      "/*.:filetype(png|jpg|jpeg|gif|svg|avif|webp|ico|css|js|mjs|map|txt|xml|webmanifest|woff|woff2|ttf|otf|webm|mp4|mp3|pdf)",
  });

  async function requestHandler(req: Request) {
    const { pathname } = new URL(req.url);

    const isFileRequest =
      isReservedAssetPath(pathname) ||
      pathname.startsWith("/.well-known") ||
      pathname === "/manifest.json" ||
      publicFilePattern.test({ pathname });

    const isApi = isApiPath(pathname);

    if (isFileRequest && !isApi) {
      const distPath = clientFilePath(pathname);
      // Served from here whatever the asset base is: a CDN in front of the
      // app uses this origin as the source it fills from. A file, not merely
      // a path that exists: `/assets` itself is `dist/client/assets`, a
      // directory, and streaming one would answer 200 and then fail mid-body.
      if (!distPath || !(await isFile(distPath))) {
        return staticAssetMiss(pathname) ?? (await handleWithApp(req, pathname));
      }

      // `Bun.file(path).stream()` is lazy — a missing file only throws ENOENT
      // once the body is streamed, which is *after* this handler has returned,
      // so the `try/catch` below can't catch it (it surfaces as an unhandled
      // rejection with the response already committed as 200). Never build the
      // streaming Response without checking existence first.

      try {
        const file = Bun.file(distPath);

        const etag = generateETag(file.lastModified);
        return new Response(file.stream(), {
          headers: {
            "Content-Type": file.type,
            "Cache-Control": "public, max-age=31536000, must-revalidate",
            "Content-Length": String(file.size),
            ETag: etag,
          },
        });
      } catch (error) {
        app.onException?.(error);
        return new Response("Not found", { status: 404 });
      }
    }

    return await handleWithApp(req, pathname);
  }

  async function handleWithApp(req: Request, pathname: string) {
    const handler = app.fetch.bind(app);

    try {
      const result = await handler(req);
      if (result instanceof Response) {
        return result;
      } else {
        const styles = [];

        styles.push({
          content: appCSSContent,
        });

        const getStyles = async (currentViews: string[]) => {
          if (!currentViews) {
            return createStyles([]);
          }
          for (const view of currentViews) {
            const clientFile = manifest[`app/views/${view}.tsx`];
            for (const cssFile of clientFile?.css ?? []) {
              const css = Bun.file(`${process.env.DIST_DIR}/client/${cssFile}`);
              styles.push({
                id: cssFile,
                content: await css.text(),
              });
            }
          }
          return createStyles(styles);
        };

        return await result({
          getStyles,
          clientEntry,
          modulePreloadManifest,
          loaders,
          viewImportMap,
          viewModules,
          ogMap,
          cssManifest,
          assetBase,
        });
      }
    } catch (err) {
      return unhandledErrorResponse(err, pathname, app.onException);
    }
  }

  // Compression is on unless the deployment opts out — set `GEMI_COMPRESSION=off`
  // when a layer in front of the origin already compresses HTML and you would
  // rather not spend origin CPU on it.
  const compressionEnabled = (process.env.GEMI_COMPRESSION ?? "auto").toLowerCase() !== "off";

  const server = Bun.serve({
    maxRequestBodySize: 10 * 1024 * 1024 * 1024, // 10 GB
    fetch: async (req, server) => {
      if (!req.headers.get("x-forwarded-for")) {
        // `requestIP` is null for closed/unix sockets — guard so it never
        // throws before the request is handled.
        const ip = server.requestIP(req);
        if (ip) req.headers.set("x-forwarded-for", ip.address);
      }
      // The app's global middleware goes in front of the static handler as well
      // as the router, so it can refuse `/assets/*` too.
      const res = await instrumentation(req, (req) =>
        app.withGlobalMiddleware(req, requestHandler, (err) =>
          unhandledErrorResponse(err, new URL(req.url).pathname, app.onException),
        ),
      );
      // Applied at the very edge, after instrumentation, so every HTML response
      // goes through the same negotiation — including the ones an app's
      // instrumentation produced itself. Anything that isn't HTML comes back
      // untouched.
      return compressionEnabled ? compressResponse(req, res) : res;
    },
    idleTimeout: Number(process.env.SERVER_IDLE_TIMEOUT ?? 10),
    port: process.env.PORT || 5173,
  });

  printStartupBanner({ port: server.port, rootDir });

  return server;
}
