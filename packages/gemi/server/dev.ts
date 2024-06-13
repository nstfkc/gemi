import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.browser";
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

  const appPath = path.join(appDir, "bootstrap.ts");
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

    const { app } = await vite.ssrLoadModule(appPath);
    const response = await app.fetch.call(app, req);
    if (response instanceof Response) {
      return response;
    }

    try {
      const { data, headers, head, status = 200 } = response;
      let viewPaths: string[] = ["RootLayout"];
      for (const [, d] of Object.entries(data.pageData)) {
        viewPaths.push(...Object.keys(d));
      }

      const viewsResult = viewPaths.map((viewPath) => {
        return (async function () {
          const mod = await vite.ssrLoadModule(
            `${appDir}/views/${viewPath}.tsx`,
          );
          return {
            [`./views/${viewPath}.tsx`]: mod,
          };
        })();
      });

      const views = (await Promise.all(viewsResult)).reduce((acc, next) => {
        return {
          ...acc,
          ...next,
        };
      }, {});

      const { Root } = await vite.ssrLoadModule("gemi/client");
      const stream = await renderToReadableStream(
        createElement(Root, {
          data,
          styles: [],
          head,
          views,
        }),
        {
          bootstrapScriptContent: `window.__GEMI_DATA__ = ${JSON.stringify(data)};`,
          bootstrapModules: [
            "/refresh.js",
            "/app/client.tsx",
            "http://localhost:5173/@vite/client",
          ],
        },
      );

      return new Response(stream, {
        status,
        headers: { ...headers, "Content-Type": "text/html" },
      });
    } catch (err) {
      return new Response(err.stack, { status: 500 });
    }
  }

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

  await vite.listen(5174);

  return server;
}
