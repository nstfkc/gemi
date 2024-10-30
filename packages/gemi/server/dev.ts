import { join } from "path";
import type { App } from "../app/App";
import { createStyles } from "./styles";
import { imageHandler } from "./imageHandler";
import { renderErrorPage } from "./renderErrorPage";
import { Serve } from "bun";

const rootDir = process.cwd();
const appDir = join(rootDir, "app");

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
        ignored: ["**/storage/**"],
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

  async function handleDevRequests(req: Request): Promise<Response> {
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
  }

  async function getApp(): Promise<App> {
    try {
      return (
        await vite.ssrLoadModule(join(appDir, "bootstrap.ts"), {
          fixStacktrace: true,
        })
      ).app;
    } catch (err) {
      vite.ws.send({ type: "error", err });
      console.error(err);
    }
  }

  async function createServe(app: App): Promise<Serve> {
    const handler = app.fetch.bind(app);
    return {
      fetch: async (req, server) => {
        if (server.upgrade(req, { data: { headers: req.headers } })) {
          return; // do not return a Response
        }
        if (!req.headers.get("x-forwarded-for")) {
          const ip = server.requestIP(req);
          req.headers.set("x-forwarded-for", ip.address);
        }

        const { pathname } = new URL(req.url);

        const devResponse = await handleDevRequests(req);
        if (devResponse instanceof Response) {
          return devResponse;
        }

        if (pathname.startsWith("/__gemi/image")) {
          return await imageHandler(req);
        }

        try {
          const result = await handler(req);
          if (result instanceof Response) {
            return result;
          } else {
            const viewImportMap = {};
            const template = (viewName: string, path: string) =>
              `"${viewName}": () => import("${path}")`;
            const templates = [];

            for (const fileName of [
              "404",
              ...app.getFlatComponentTree.call(app),
            ]) {
              if (process.env.NODE_ENV === "test") {
                break;
              }
              const appDir = `${process.env.APP_DIR}`;
              const mod = await vite.ssrLoadModule(
                `${appDir}/views/${fileName}.tsx`,
              );
              viewImportMap[fileName] = mod.default;
              templates.push(
                template(fileName, `${appDir}/views/${fileName}.tsx`),
              );
            }

            const loaders = `{${templates.join(",")}}`;
            const { default: css } = await vite.ssrLoadModule(
              `${appDir}/app.css`,
            );

            const styles = [];
            styles.push({
              isDev: true,
              id: `${appDir}/app.css`,
              content: css,
            });
            return await result({
              styles: createStyles(styles),
              bootstrapModules: [
                "/refresh.js",
                "/app/client.tsx",
                "http://localhost:5173/@vite/client",
              ],
              viewImportMap,
              loaders,
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
          return new Response(renderErrorPage(err), {
            headers: { "Content-Type": "text/html" },
          });
        }
      },
      port: process.env.PORT || 5173,
      websocket: app.websocket,
    };
  }

  await vite.listen(5174);

  const app = await getApp();
  const serve = await createServe(app);
  const server = Bun.serve(serve);
  app.onPublish(
    (
      topic: string,
      data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
      compress?: boolean,
    ) => {
      server.publish(topic, data, compress);
    },
  );

  console.log(`Server started on http://localhost:${process.env.PORT || 5173}`);

  vite.watcher.on("change", async (file) => {
    const fileRelativePath = file.replace(rootDir, "");
    if (fileRelativePath.startsWith("/logs")) {
      return;
    }
    if (fileRelativePath.startsWith("/app/views")) {
      console.log(`[vite] ${fileRelativePath} changed. 🍜 Hot reloading...`);
      return;
    }

    console.log(`[vite] ${fileRelativePath} changed. Reloading...`);
    const modules = vite.moduleGraph.getModulesByFile(file) ?? [];
    for (const mod of Array.from(modules)) {
      vite.moduleGraph.invalidateModule(mod);
    }

    try {
      const app = await getApp();
      const serve = await createServe(app);
      app.onPublish(
        (
          topic: string,
          data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
          compress?: boolean,
        ) => {
          server.publish(topic, data, compress);
        },
      );
      server.reload(serve);
      vite.ws.send({
        type: "custom",
        event: "http-reload",
      });
    } catch (err) {
      console.log("Error on server reload");
      console.log(err);
      vite.ws.send({
        type: "error",
        err,
      });
    }
  });

  return server;
}
