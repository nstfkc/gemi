import "react";
import path from "path";
import { Server } from "./Server";
import { App } from "../app";
import { createElement } from "react";

import { renderToReadableStream } from "react-dom/server.browser";
import { imageHandler } from "./imageHandler";

const rootDir = process.cwd();

const appDir = path.join(rootDir, "app");
const frameworkDir = path.join(rootDir, "framework");

export async function main() {
  console.log("Starting server...");
  const server = new Server();
  const root = process.cwd();

  const vite = await (
    await import("vite")
  ).createServer({
    root,
    logLevel: "error",
    server: {
      watch: {
        usePolling: true,
        interval: 100,
      },
      hmr: {
        clientPort: 5174,
      },
    },
    appType: "custom",
    resolve: {
      alias: {
        "@/app": appDir,
        "@/framework": frameworkDir,
      },
    },
  });

  const { app } = (await vite.ssrLoadModule(
    path.join(rootDir, "app/bootstrap.ts"),
  )) as { app: App };

  vite.watcher.on("change", async (filePath) => {
    if (filePath.includes("/app/views")) {
      return;
    }
    const m = await vite.moduleGraph.getModuleByUrl(filePath, true);
    if (m) {
      await vite.reloadModule(m);
    }
  });

  server.use("/__gemi/image", imageHandler);

  server.use(
    "*",
    async (req, next) => {
      const { pathname } = new URL(req.url);
      const res = await fetch(`http://localhost:5174/${pathname}`);
      if (res.ok) {
        return res;
      } else {
        return await next();
      }
    },

    async (req) => {
      const styles = [];
      for (const [file, modules] of vite.moduleGraph.fileToModulesMap) {
        for (const mod of modules) {
          if (
            mod.file &&
            mod.file.includes(".css") &&
            !mod.file.includes("app.css")
          ) {
            const { default: css } = await vite.ssrLoadModule(file);
            const currentFiles: string[] = styles.map((s) => s.file);
            if (currentFiles.includes(mod.file)) {
              continue;
            }
            styles.push({
              file: mod.file,
              css,
            });
          }
        }
      }

      const result = await app.handleRequest(req);

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

      if (!result) {
        return new Response("Not found", { status: 404 });
      }

      const { default: Root } = await vite.ssrLoadModule("framework/Root.tsx");

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
        const stream = await renderToReadableStream(
          createElement(Root, { data, styles: [], head }),
          {
            bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(data)};`,
            bootstrapModules: [
              "/framework/refresh.js",
              "/framework/main.tsx",
              "http://localhost:5173/@vite/client",
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
    },
  );

  await vite.listen(5174);

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;

  Bun.serve({
    fetch: (req, s) => {
      if (s.upgrade(req)) {
        return;
      }
      return server.fetch.call(server, req);
    },
    port: process.env.PORT || 5173,
    websocket: app.websocket,
  });
}

main();
