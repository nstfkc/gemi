import { join } from "node:path";
import { generateETag } from "./generateEtag";
import { URLPattern } from "urlpattern-polyfill";
import { exists } from "node:fs/promises";
import { createStyles } from "./styles";
import type { App } from "../app";
import { Instrumentation } from "./types";
import { printStartupBanner } from "./banner";
import { RESERVED_ROUTE_PREFIX } from "../services/router/ViewRouterServiceContainer";

const projectDir = process.env.GEMI_PROJECT_DIR ?? "";
const rootDir = join(process.cwd(), projectDir);

const appDir = join(rootDir, "app");
const distDir = join(rootDir, "dist");

// `app` is built by `Server.start` (from the kernel) and passed in — same as
// `httpDev` — so prod and dev share one construction path. What differs here is
// that views/styles are served from the built `dist/` manifests instead of
// Vite's dev SSR graph.
export async function httpProd(app: App, instrumentation: Instrumentation) {
  const manifest = await import(`${distDir}/client/.vite/manifest.json`);
  const serverManifest = await import(`${distDir}/server/.vite/manifest.json`);

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;
  process.env.DIST_DIR = distDir;

  const viewImportMap = {};
  const ogMap = {};
  const cssManifest = {};
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
    const clientFile = manifest[`app/views/${fileName}.tsx`];

    if (clientFile?.css && clientFile?.css.length > 0) {
      cssManifest[fileName] = clientFile?.css;
    }
    if (clientFile) {
      templates.push(template(fileName, `/${clientFile?.file}`));
    }
  }

  const loaders = `{${templates.join(",")}}`;

  // Vite's manifest `css` field is a `string[]` — a client entry can emit more
  // than one CSS chunk. Read and concatenate them all instead of interpolating
  // the array into a single path (which only works for a one-element array).
  const appCssFiles: string[] = manifest["app/client.tsx"]?.css ?? [];
  const appCSSContent = (
    await Promise.all(appCssFiles.map((cssFile) => Bun.file(`${distDir}/client/${cssFile}`).text()))
  ).join("\n");

  const staticFilePattern = new URLPattern({
    pathname: "/*.:filetype(png|txt|js|css|jpg|svg|jpeg|avif|webp|ico|ttf|map)",
  });

  async function requestHandler(req: Request) {
    const { pathname } = new URL(req.url);

    const isWellKnownFile = pathname.startsWith("/.well-known");
    const isFileRequest = staticFilePattern.test({ pathname }) || isWellKnownFile;

    const isApi = pathname.startsWith("/api");

    if (isFileRequest && !isApi) {
      const url = new URL(req.url);
      const filePath = req.url.replace(url.origin, "").split("?")[0];
      const distPath = `${distDir}/client${filePath.replace("/assets/assets", "/assets")}`;
      const doesExist = await exists(distPath);

      if (!doesExist && url.pathname.includes(".js")) {
        return new Response(
          `if(caches){caches?.delete("${distPath}")}window.location.reload();export {}`,
          {
            headers: { "Content-Type": "application/javascript" },
          },
        );
      }

      if (!doesExist) {
        // `/assets` is reserved for build output (the router rejects routes
        // there at boot), so a miss is a miss — 404 without paying for an SSR
        // render.
        if (
          pathname === RESERVED_ROUTE_PREFIX ||
          pathname.startsWith(`${RESERVED_ROUTE_PREFIX}/`)
        ) {
          return new Response("Not found", { status: 404 });
        }

        // Anywhere else the pattern above matched on extension alone, so this
        // may well be an app route — a file route like
        // `this.file(() => Bun.file(...))` mounted at `/files/logo.svg` lands
        // here too. Hand it to the app rather than 404ing on its behalf.
        return await handleWithApp(req, pathname);
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
          bootstrapModules: [`/${manifest["app/client.tsx"].file}`],
          loaders,
          viewImportMap,
          ogMap,
          cssManifest,
        });
      }
    } catch (err) {
      console.error(err);
      if (pathname.startsWith("/api")) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      app.onException?.(err);
      return new Response(err.stack, { status: 500 });
    }
  }

  const server = Bun.serve({
    maxRequestBodySize: 10 * 1024 * 1024 * 1024, // 10 GB
    fetch: async (req, server) => {
      if (!req.headers.get("x-forwarded-for")) {
        // `requestIP` is null for closed/unix sockets — guard so it never
        // throws before the request is handled.
        const ip = server.requestIP(req);
        if (ip) req.headers.set("x-forwarded-for", ip.address);
      }
      return await instrumentation(req, requestHandler);
    },
    idleTimeout: Number(process.env.SERVER_IDLE_TIMEOUT ?? 10),
    port: process.env.PORT || 5173,
  });

  printStartupBanner({ port: server.port, rootDir });

  return server;
}
