import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { ASSET_FALLBACK_HEADER } from "./assetFallback";

/**
 * `GEMI_ASSET_FALLBACK_URL`: a build asset this release does not have is
 * fetched from the store every release uploads to, against a real built-output
 * directory, `Bun.serve`, and a second server standing in for the store.
 */

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
  };
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = {};
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
      },
    },
  };
}

let projectDir: string;
let server: { port: number; stop: (force?: boolean) => unknown };
let store: ReturnType<typeof Bun.serve>;
const storeRequests: string[] = [];
const savedEnv = { ...process.env };

beforeAll(async () => {
  store = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      storeRequests.push(pathname);
      if (pathname === "/web/assets/Other-release.js") {
        return new Response("export default 1;", {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (pathname === "/web/assets/other-release.css") {
        return new Response("body{}", { headers: { "content-type": "text/css" } });
      }
      return new Response("BlobNotFound", { status: 404 });
    },
  });

  projectDir = await mkdtemp(join(tmpdir(), "gemi-prod-asset-fallback-"));
  const dist = join(projectDir, "dist");
  await mkdir(join(dist, "client/.vite"), { recursive: true });
  await mkdir(join(dist, "client/assets"), { recursive: true });
  await mkdir(join(dist, "server/.vite"), { recursive: true });

  const app = new App({ kernel: AppKernel });
  const clientManifest: Record<string, { file: string; isEntry?: boolean }> = {
    "app/client.tsx": { file: "assets/client.js", isEntry: true },
  };
  const serverManifest: Record<string, { file: string }> = {};
  for (const [i, view] of ["404", ...app.getFlatComponentTree()].entries()) {
    clientManifest[`app/views/${view}.tsx`] = { file: `assets/${view.replaceAll("/", "-")}.js` };
    serverManifest[`app/views/${view}.tsx`] = { file: `view-${i}.js` };
    await writeFile(join(dist, `server/view-${i}.js`), "export default function View() { return null; }\n");
  }
  await writeFile(join(dist, "client/.vite/manifest.json"), JSON.stringify(clientManifest));
  await writeFile(join(dist, "client/assets/client.js"), "// this release's client");
  await writeFile(join(dist, "server/.vite/manifest.json"), JSON.stringify(serverManifest));
  vi.doMock(join(dist, "server/.vite/manifest.json"), () => serverManifest);
  vi.doMock(join(dist, "client/.vite/manifest.json"), () => clientManifest);

  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  process.env.PORT = "0";
  process.env.SECRET ??= "test-secret";
  process.env.GEMI_COMPRESSION = "off";
  process.env.GEMI_ASSET_FALLBACK_URL = `http://localhost:${store.port}/web`;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const { httpProd } = await import("./httpProd");
  server = (await httpProd(app, (req, next) => next(req))) as any;
});

afterAll(async () => {
  server?.stop(true);
  store?.stop(true);
  process.env = savedEnv;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(`http://localhost:${server.port}${path}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("httpProd: GEMI_ASSET_FALLBACK_URL", () => {
  test("this release's own file is served from disk, without asking the store", async () => {
    const res = await get("/assets/client.js");
    expect(res.body).toBe("// this release's client");
    expect(res.headers.get(ASSET_FALLBACK_HEADER)).toBeNull();
    expect(storeRequests).not.toContain("/web/assets/client.js");
  });

  test("another release's chunk comes from the store, as an immutable module", async () => {
    const res = await get("/assets/Other-release.js");
    expect(res.status).toBe(200);
    expect(res.body).toBe("export default 1;");
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get(ASSET_FALLBACK_HEADER)).toBe("1");
  });

  test("another release's stylesheet comes from the store too", async () => {
    const res = await get("/assets/other-release.css");
    expect(res.status).toBe(200);
    expect(res.body).toBe("body{}");
  });

  test("a chunk the store does not have either still gets the reload stub", async () => {
    const res = await get("/assets/gone-123.js");
    expect(storeRequests).toContain("/web/assets/gone-123.js");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toContain("window.location.reload()");
  });

  test("any other miss is still a 404", async () => {
    const res = await get("/assets/gone.css");
    expect(res.status).toBe(404);
  });
});
