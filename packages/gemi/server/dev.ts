import path from "path";
import open from "open";

import type { App } from "../app/App";
import { createStyles } from "./styles";
import { imageHandler } from "./imageHandler";
import { renderErrorPage } from "./renderErrorPage";

const rootDir = process.cwd();

const appDir = path.join(rootDir, "app");

export async function startDevServer() {
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
      },
    },
  });

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;

  async function requestHandler(req: Request) {
    const { pathname } = new URL(req.url);

    if (pathname.startsWith("/__gemi/image")) {
      return await imageHandler(req);
    }

    if (pathname.startsWith("/refresh.js")) {
      return new Response(
        `
          import RefreshRuntime from "http://localhost:5173/@react-refresh";
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

    try {
      const res = await fetch(`http://localhost:5174${pathname}`);

      if (res.ok) {
        return res;
      }
    } catch (err) {
      console.log(err);
    }

    let app: App | null = null;

    try {
      app = (await vite.ssrLoadModule(path.join(appDir, "bootstrap.ts"))).app;
    } catch (err) {
      return new Response(renderErrorPage(err), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    const { default: css } = await vite.ssrLoadModule(`${appDir}/app.css`);
    const styles = [];
    styles.push({
      isDev: true,
      id: `${appDir}/app.css`,
      content: css,
    });

    app.setRenderParams({
      styles: createStyles(styles),
      manifest: null,
      serverManifest: null,
      bootstrapModules: [
        "/refresh.js",
        "/app/client.tsx",
        "http://localhost:5173/@vite/client",
      ],
    });

    const handler = app.fetch.bind(app);

    try {
      return await handler(req);
    } catch (err) {
      return new Response(renderErrorPage(err), {
        headers: { "Content-Type": "text/html" },
      });
    }
  }
  await vite.listen(5174);

  const server = Bun.serve({
    fetch: async (req) => {
      return await requestHandler(req);
    },
    port: process.env.PORT || 5173,
  });

  console.log(`Server started on http://localhost:${process.env.PORT || 5173}`);
  await open(`http://localhost:${process.env.PORT || 5173}`);

  vite.watcher.on("change", async (file) => {
    if (file.includes("app/views")) {
      return;
    }

    console.log(`[vite] ${file} changed. Updating...`);

    const mod = await vite.moduleGraph.getModuleByUrl(`/${file}`);
    if (mod) {
      console.log(`[vite] ${file} changed. Updating...`);
      // await vite.reloadModule(mod);
    }
  });

  return server;
}
