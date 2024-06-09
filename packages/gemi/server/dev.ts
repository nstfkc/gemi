import "react";

import path from "path";

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
        cwd: root,
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

  const appPath = path.join(appDir, "bootstrap.ts");

  async function requestHandler(req: Request) {
    const { app } = await vite.ssrLoadModule(appPath);
    return app.fetch.call(app, req);
  }

  const server = Bun.serve({
    fetch: async (req) => {
      return requestHandler(req);
    },
    port: process.env.PORT || 5173,
  });

  vite.watcher.on("change", async (file) => {
    if (file.includes("app/views")) {
      return;
    }

    const mod = await vite.moduleGraph.getModuleByUrl(`/${file}`);
    if (mod) {
      console.log(`[vite] ${file} changed. Updating...`);
      await vite.reloadModule(mod);
    }
  });

  await vite.listen(5174);

  return server;
}
