import { join } from "path";
import { imageHandler } from "./imageHandler";
import { generateETag } from "./generateEtag";
import { URLPattern } from "urlpattern-polyfill";
import { createStyles } from "./styles";

const rootDir = process.cwd();

const appDir = join(rootDir, "app");
const distDir = join(rootDir, "dist");

export async function startProdServer() {
  const { app } = await import(`${distDir}/server/bootstrap.mjs`);
  const manifest = await import(`${distDir}/client/.vite/manifest.json`);
  const serverManifest = await import(`${distDir}/server/.vite/manifest.json`);

  process.env.ROOT_DIR = rootDir;
  process.env.APP_DIR = appDir;
  process.env.DIST_DIR = distDir;

  async function requestHandler(req: Request) {
    const { pathname } = new URL(req.url);

    if (pathname.startsWith("/__gemi/image")) {
      return await imageHandler(req);
    }

    const pattern = new URLPattern({
      pathname: "/*.:filetype(png|txt|js|css|jpg|svg|jpeg|ico|ttf)",
    });

    const isApi = pathname.startsWith("/api");

    if (pattern.test({ pathname }) && !isApi) {
      const url = new URL(req.url);
      const filePath = req.url.replace(url.origin, "").split("?")[0];
      const file = Bun.file(
        `dist/client${filePath.replace("/assets/assets", "/assets")}`,
      );
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
    }

    const styles = [];
    const cssFile = Bun.file(
      `${distDir}/client/${manifest["app/client.tsx"].css}`,
    );
    const cssContent = await cssFile.text();
    styles.push({
      content: cssContent,
    });

    const viewImportMap = {};
    const template = (viewName: string, path: string) =>
      `"${viewName}": () => import("${path}")`;
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
      const mod = await import(
        `${process.env.DIST_DIR}/server/${serverFile?.file}`
      );
      viewImportMap[fileName] = mod.default;
      const clientFile = manifest[`app/views/${fileName}.tsx`];
      if (clientFile) {
        templates.push(template(fileName, `/${clientFile?.file}`));
      }
    }

    const loaders = `{${templates.join(",")}}`;

    const handler = app.fetch.bind(app);

    try {
      const result = await handler(req);
      if (result instanceof Response) {
        return result;
      } else {
        return await result({
          styles: createStyles(styles),
          bootstrapModules: [`/${manifest["app/client.tsx"].file}`],
          loaders,
          viewImportMap,
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
      return new Response(err.stack, { status: 500 });
    }
  }

  const server = Bun.serve({
    fetch: async (req, server) => {
      if (!req.headers.get("x-forwarded-for")) {
        const ip = server.requestIP(req);
        req.headers.set("x-forwarded-for", ip.address);
      }
      return await requestHandler(req);
    },
    port: process.env.PORT || 5173,
  });

  console.log("Production server running on", server.url.href);

  return server;
}
