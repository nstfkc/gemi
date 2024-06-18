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

  const cssFile = Bun.file(
    `${distDir}/client/${manifest["app/client.tsx"].css}`,
  );
  const cssContent = await cssFile.text();

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

    if (pattern.test({ pathname })) {
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

    const handler = app.fetch.bind(app);

    const styles = [];
    styles.push({
      content: cssContent,
    });
    try {
      return await handler(req, {
        styles: createStyles(styles),
        views: {},
        manifest,
        serverManifest,
        bootstrapModules: [`/${manifest["app/client.tsx"].file}`],
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

  return server;
}
