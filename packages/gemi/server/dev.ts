import path from "path";

import type { App } from "../app/App";

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
        // ignored: (str) => str.includes("app/http"),
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

    const { app } = (await vite.ssrLoadModule(
      path.join(appDir, "bootstrap.ts"),
    )) as { app: App };

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

    const handler = app.fetch.bind(app);

    try {
      const { default: css } = await vite.ssrLoadModule(`${appDir}/app.css`);
      const styles = [];
      styles.push({
        isDev: true,
        id: `${appDir}/app.css`,
        content: css,
      });

      return await handler(req, {
        styles,
        views: {},
        bootstrapModules: [
          "/refresh.js",
          "/app/client.tsx",
          "http://localhost:5173/@vite/client",
        ],
      });
    } catch (err) {
      return new Response(err.stack, { status: 500 });
    }
  }
  await vite.listen(5174);

  const server = Bun.serve({
    fetch: async (req) => {
      return await requestHandler(req);
    },
    port: process.env.PORT || 5173,
  });

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
