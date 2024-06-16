import path from "path";
import { app } from "./app/bootstrap";
import RootLayout from "./app/views/RootLayout";
import { renderToReadableStream } from "react-dom/server.browser";
import { createElement } from "react";
import { URLPattern } from "urlpattern-polyfill";

const rootDir = process.cwd();
process.env.ROOT_DIR = rootDir;
process.env.APP_DIR = path.join(rootDir, "app");

const appDir = path.join(rootDir, "app");
const distDir = path.join(rootDir, "dist");

async function main() {
  const manifest = await import(
    path.join(distDir, "client/.vite/manifest.json")
  );

  async function handleRequest(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("__gemi/image")) {
      // return imageHandler(req);
    }
    const pattern = new URLPattern({
      pathname: "/*.:filetype(png|txt|js|css|jpg|svg|jpeg|ico|ttf)",
    });
    if (pattern.test({ pathname })) {
      const url = new URL(req.url);
      const filePath = req.url.replace(url.origin, "").split("?")[0];
      const file = Bun.file(`dist/client${filePath}`);
      if (!file) {
        return new Response("Not found", { status: 404 });
      }
      // const etag = generateETag(file.lastModified);
      return new Response(file.stream(), {
        headers: {
          "Content-Type": file.type,
          "Cache-Control": "public, max-age=31536000, must-revalidate",
          "Content-Length": String(file.size),
          ETag: "",
        },
      });
    }

    const response = await app.fetch.call(app, req);
    if (response instanceof Response) {
      return response;
    }

    const { data, headers, head, status = 200 } = response;

    const { routeManifest, router, pageData } = data;

    const preloadModules = Array.from(
      new Set(
        ["RootLayout", ...(routeManifest?.[router.pathname] ?? [])]
          .map((componentPath) => [
            `app/views/${componentPath}.tsx`,
            ...manifest[`app/views/${componentPath}.tsx`].imports.filter(
              (p) => p !== "app/client.tsx",
            ),
          ])
          .flat()
          .filter((file) => file.length > 0)
          .map((file) => `/${manifest[file].file}`),
      ),
    );

    const stream = await renderToReadableStream(
      createElement(RootLayout, {
        data,
        styles: [],
        head,
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
      headers: {
        "Content-Type": "text/html",
        ...headers,
      },
    });
  }

  Bun.serve({
    fetch: async (req) => {
      return await handleRequest(req);
    },
    port: 5173,
  });
}

main();
