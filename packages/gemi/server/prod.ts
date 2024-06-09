import { createElement } from "react";
import path from "path";
import { Server } from "./Server";
import { renderToReadableStream } from "react-dom/server.browser";
import { Root } from "../client/Root";
import { imageHandler } from "./imageHandler";
import { generateETag } from "./generateEtag";

export async function startProdServer() {
  const rootDir = process.cwd();
  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = path.join(rootDir, "app");

  const appDir = path.join(rootDir, "app");
  const distDir = path.join(rootDir, "dist");

  const { app } = await import(path.join(appDir, "bootstrap.ts"));

  const manifest = await import(
    path.join(distDir, "client/.vite/manifest.json")
  );

  const { URLPattern } = await import("urlpattern-polyfill");
  const s = new Server(URLPattern);

  s.use("/__gemi/image", async (req) => {
    return await imageHandler(req);
  });

  s.use("/*.:filetype(png|txt|js|css|jpg|svg|jpeg|ico|ttf)", async (req) => {
    const url = new URL(req.url);
    const filePath = req.url.replace(url.origin, "").split("?")[0];
    const file = Bun.file(`dist/client${filePath}`);
    if (!file) {
      return new Response("Not found", { status: 404 });
    }
    const etag = generateETag(file.lastModified);
    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type,
        "Cache-Control": "public, max-age=31536000, must-revalidate",
        "Content-Length": String(file.size),
        ETag: etag,
      },
    });
  });

  s.use("*", async (req) => {
    const result = await app.handleRequest(req);
    if (!result) {
      return new Response("Not found", { status: 404 });
    }

    if (result.kind === "viewError") {
      const { kind, ...payload } = result;
      return new Response(null, {
        ...payload,
      });
    }

    if (result.kind === "apiError") {
      const { kind, data, ...payload } = result;
      return new Response(JSON.stringify(data), {
        ...payload,
      });
    }

    if (result.kind === "viewData") {
      const { data, headers, head } = result;
      return new Response(
        JSON.stringify({
          data,
          head,
        }),
        {
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (result.kind === "view") {
      const { data, headers, head, status = 200 } = result;
      const { routeManifest, router } = data;
      const preloadModules = Array.from(
        new Set(
          ["RootLayout", ...(routeManifest?.[router.pathname] ?? [])]
            .map((componentPath: string) => [
              `app/views/${componentPath}.tsx`,
              ...manifest[`app/views/${componentPath}.tsx`].imports.filter(
                (p: string) => p !== "app/client.tsx",
              ),
            ])
            .flat()
            .filter((file) => file.length > 0)
            .map((file) => `/${manifest[file].file}`),
        ),
      );

      const stream = await renderToReadableStream(
        createElement(Root, {
          data,
          head,
          styles: manifest["app/views/RootLayout.tsx"].css,
        }),
        {
          bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(data)};`,
          bootstrapModules: [
            `/${manifest["app/client.tsx"].file}`,
            ...preloadModules,
          ],
        },
      );

      return new Response(stream, {
        status,
        headers: { ...headers, "Content-Type": "text/html" },
      });
    } else if (result.kind === "api") {
      const { data, headers, status } = result;
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      });
    } else if (result.kind === "api_404") {
      return new Response("Not found", { status: 404 });
    }
  });

  return Bun.serve({
    fetch: (req) => s.fetch.call(s, req),
    port: process.env.PORT || 80,
  });
}
