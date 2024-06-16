import { type App } from "../app/App";
import path from "path";

interface Params {
  app: App;
  RootLayout: () => JSX.Element;
}

export async function createDevServer(params: Params) {
  const { app, RootLayout } = params;
  const rootDir = process.cwd();

  const appDir = path.join(rootDir, "app");
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

    return await handler(req, {
      RootLayout,
      options: {
        bootstrapModules: [
          "/refresh.js",
          "/app/client.tsx",
          "http://localhost:5173/@vite/client",
        ],
      },
    });
  }

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

  await vite.listen(5174);

  const server = Bun.serve({
    fetch: async (req) => {
      return await requestHandler(req);
    },
    port: process.env.PORT || 5173,
  });

  return server;
}
