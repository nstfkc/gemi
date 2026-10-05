import { join, resolve, sep } from "node:path";
import { compressResponse } from "./compression";
import { listPublicFiles, staticFileResponse } from "./staticFile";
import { stat } from "node:fs/promises";
import { createStyles } from "./styles";
import {
  CLIENT_ENTRY_KEY,
  collectCss,
  collectModulePreloads,
  createClientEntry,
  createIslandResolver,
} from "./modulePreloads";
import type { App } from "../app";
import { Instrumentation } from "./types";
import { printStartupBanner } from "./banner";
import { isReservedAssetPath, staticAssetMiss } from "./staticAssetMiss";
import { assetUrl, readBuiltAssetBase } from "../config/assetBase";
import { isApiPath } from "../services/router/apiPath";
import { projectRoot } from "../support/discover";
import { unhandledErrorResponse } from "./unhandledError";
import { applyForwardedTrust, parseTrustProxy } from "./forwardedFor";
import { readStaticAssetsRecord } from "../vite/precompressAssets";
import type { StaticFileOptions } from "./staticFile";

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

  // The island entries (`<module>?gemi-island`) a static view's document
  // loads; see `injectIslands`.
  const resolveIsland = createIslandResolver(manifest, assetBase);

  // A static view's CSS comes from the whole import closure of its views (and
  // its own layout's, which then replaces the app stylesheet): there is no
  // client to fetch a shared chunk's CSS later, as a hydrated page's chunk
  // loader does. Read once per file: the build does not change under a
  // running server.
  const cssFileCache = new Map<string, Promise<string>>();
  const readCss = (file: string) => {
    let text = cssFileCache.get(file);
    if (!text) {
      text = Bun.file(`${distDir}/client/${file}`).text();
      cssFileCache.set(file, text);
    }
    return text;
  };
  const staticStyles = async (views: string[], layout: string | undefined) => {
    const files = new Set<string>();
    for (const view of layout ? [layout, ...views] : views) {
      for (const file of collectCss(manifest, `app/views/${view}.tsx`)) files.add(file);
    }
    const styles = await Promise.all(
      [...files].map(async (file) => ({ id: file, content: await readCss(file) })),
    );
    return createStyles(layout ? styles : [{ content: appCSSContent }, ...styles]);
  };

  // Which requests are answered from `dist/client` rather than the app:
  //
  // - `/assets` and everything under it, whatever the extension. Vite writes
  //   fonts, GIFs, video and `?url` JSON there too, and an allowlist of
  //   extensions always trailed the build — a `.woff2` went to the router
  //   and paid for an SSR attempt. The router refuses routes under `/assets`
  //   at boot, so there is no app answer to lose, and `staticAssetMiss`
  //   turns a miss into the reload stub or a 404.
  // - `/.well-known/*`.
  // - Any other path that names a file the build copied out of `public/`,
  //   whatever its extension (#583). Any other path may be an app route, so
  //   it is static only when that exact file exists — read once here, since
  //   the build output does not change under a running server. A view at
  //   `/manifest` keeps its data URL (`/manifest.json`) unless the app also
  //   ships `public/manifest.json`, and then the file wins. View data is
  //   never a file in `dist/client`, so a client-side navigation pays for no
  //   filesystem lookup.
  const publicFiles = await listPublicFiles(clientDir);

  // The build assets `gemi build` emitted or carried over, with the
  // precompressed siblings it wrote for each (#789). Read once: the build
  // output does not change under a running server. Without the record (a
  // build made before it existed) every file is served as identity with the
  // old cache policy.
  const staticAssets = new Map<string, StaticFileOptions>();
  for (const [file, encodings] of Object.entries(
    (await readStaticAssetsRecord(clientDir))?.files ?? {},
  )) {
    const path = resolve(clientDir, file);
    if (path.startsWith(clientDir + sep)) {
      staticAssets.set(path, { immutable: true, encodings });
    }
  }

  async function requestHandler(req: Request) {
    const { pathname } = new URL(req.url);

    if (isApiPath(pathname)) {
      return await handleWithApp(req, pathname);
    }

    const distPath = clientFilePath(pathname);
    const isFileRequest =
      isReservedAssetPath(pathname) ||
      pathname.startsWith("/.well-known") ||
      (distPath !== null && publicFiles.has(distPath));

    if (isFileRequest) {
      // Served from here whatever the asset base is: a CDN in front of the
      // app uses this origin as the source it fills from. A file, not merely
      // a path that exists: `/assets` itself is `dist/client/assets`, a
      // directory, and streaming one would answer 200 and then fail mid-body.
      //
      // `Bun.file(path).stream()` is lazy — a missing file only throws ENOENT
      // once the body is streamed, which is *after* this handler has returned,
      // with the response already committed as 200. So existence is checked
      // here, per request, even for a path `publicFiles` lists.
      if (!distPath || !(await isFile(distPath))) {
        return staticAssetMiss(pathname) ?? (await handleWithApp(req, pathname));
      }

      try {
        return await staticFileResponse(req, distPath, staticAssets.get(distPath));
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

        const getStyles = async (
          currentViews: string[],
          options?: { static?: boolean; layout?: string },
        ) => {
          if (!currentViews) {
            return createStyles([]);
          }
          if (options?.static) {
            return staticStyles(currentViews, options.layout);
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
          resolveIsland,
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

  // Which `X-Forwarded-For` entries to believe — see `forwardedFor.ts`. Parsed
  // before `Bun.serve` so a bad value fails the boot, not every request.
  const forwardedTrust = parseTrustProxy(process.env.GEMI_TRUST_PROXY);

  const server = Bun.serve({
    maxRequestBodySize: 10 * 1024 * 1024 * 1024, // 10 GB
    fetch: async (req, server) => {
      // `requestIP` is null for closed/unix sockets — guard so it never
      // throws before the request is handled.
      applyForwardedTrust(req.headers, server.requestIP(req)?.address ?? null, forwardedTrust);
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
