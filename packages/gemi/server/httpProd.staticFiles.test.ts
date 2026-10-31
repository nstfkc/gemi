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

/**
 * #1015: a `route.domains` group may opt out of the files copied out of
 * `public/` (and answer `/robots.txt` itself) and own what the build has no
 * file for under `/assets`. Against a real built-output directory and
 * `Bun.serve`; the host comes from `X-Forwarded-Host` (`trustProxy: true`).
 */

const text = (body: string, name: string) => () => new File([body], name, { type: "text/plain" });

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
  };
}

class ShopViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
    "/robots.txt": this.file(text("shop robots", "robots.txt")),
    "/assets/:path*": this.file((req: any) => new File([`media ${req.params.path}`], "media.txt")),
    "/image/:path*": this.file((req: any) => new File([`image ${req.params.path}`], "image.txt")),
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
      domains: {
        root: "example.test",
        trustProxy: true,
        groups: [
          {
            subdomain: ":shop",
            view: { rootRouter: ShopViewRouter, publicFiles: false, assetRoutes: true },
          },
          // Shares the root's views, and so serves `public/` as the root does.
          { subdomain: "admin" },
        ],
        custom: {
          group: ":shop",
          resolve: (host: string) => {
            if (host === "broken.test") throw new Error("database down");
            return null;
          },
        },
      },
    },
  };
}

let projectDir: string;
let server: { port: number; stop: (force?: boolean) => unknown };
const savedEnv = { ...process.env };

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "gemi-prod-static-files-"));
  const dist = join(projectDir, "dist");
  await mkdir(join(dist, "client/.vite"), { recursive: true });
  await mkdir(join(dist, "client/assets"), { recursive: true });
  await mkdir(join(dist, "client/.well-known"), { recursive: true });
  await mkdir(join(dist, "server/.vite"), { recursive: true });

  const app = new App({ kernel: AppKernel });
  const clientManifest: Record<string, { file: string; isEntry?: boolean; css?: string[] }> = {
    "app/client.tsx": { file: "assets/client.js", isEntry: true },
  };
  for (const view of ["404", ...app.getFlatComponentTree()]) {
    clientManifest[`app/views/${view}.tsx`] = { file: `assets/${view.replaceAll("/", "-")}.js` };
  }
  await writeFile(join(dist, "client/.vite/manifest.json"), JSON.stringify(clientManifest));
  await writeFile(join(dist, "client/assets/client.js"), "// client");
  await writeFile(join(dist, "client/robots.txt"), "panel robots");
  await writeFile(join(dist, "client/.well-known/security.txt"), "security");

  const serverManifest: Record<string, { file: string }> = {};
  for (const [i, view] of ["404", ...app.getFlatComponentTree()].entries()) {
    serverManifest[`app/views/${view}.tsx`] = { file: `view-${i}.js` };
    await writeFile(join(dist, `server/view-${i}.js`), "export default function View() { return null; }\n");
  }
  await writeFile(join(dist, "server/.vite/manifest.json"), JSON.stringify(serverManifest));
  vi.doMock(join(dist, "server/.vite/manifest.json"), () => serverManifest);
  vi.doMock(join(dist, "client/.vite/manifest.json"), () => clientManifest);

  process.env.GEMI_PROJECT_DIR = relative(process.cwd(), projectDir);
  process.env.PORT = "0";
  process.env.SECRET ??= "test-secret";
  process.env.GEMI_COMPRESSION = "off";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const { httpProd } = await import("./httpProd");
  server = (await httpProd(app, (req, next) => next(req))) as any;
});

afterAll(async () => {
  server?.stop(true);
  process.env = savedEnv;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

async function get(host: string, path: string) {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    headers: { "x-forwarded-host": host },
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

describe("httpProd: public/ files per host (#1015)", () => {
  test("the root host gets the static file", async () => {
    const res = await get("example.test", "/robots.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("panel robots");
  });

  test("a group sharing the root's views gets it too", async () => {
    expect((await get("admin.example.test", "/robots.txt")).body).toBe("panel robots");
  });

  test("a group with publicFiles: false gets its own route", async () => {
    const res = await get("acme.example.test", "/robots.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("shop robots");
  });

  test("/.well-known is served on every host", async () => {
    expect((await get("acme.example.test", "/.well-known/security.txt")).body).toBe("security");
  });
});

describe("httpProd: /assets per host (#1015)", () => {
  test("a build file is served on a group that owns /assets", async () => {
    const res = await get("acme.example.test", "/assets/client.js");
    expect(res.status).toBe(200);
    expect(res.body).toBe("// client");
  });

  test("a path the build has no file for reaches the group's route", async () => {
    const res = await get("acme.example.test", "/assets/products/42.jpg");
    expect(res.status).toBe(200);
    expect(res.body).toBe("media products/42.jpg");
  });

  test("a missing chunk keeps the reload stub", async () => {
    const res = await get("acme.example.test", "/assets/gone-123.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the root host still answers a miss under /assets with a 404", async () => {
    const res = await get("example.test", "/assets/products/42.jpg");
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  test("/image/* is an ordinary path a group's routes answer", async () => {
    expect((await get("acme.example.test", "/image/a/b.png")).body).toBe("image a/b.png");
  });
});

describe("httpProd: a host that fails to resolve (#1015)", () => {
  test.each(["/robots.txt", "/assets/products/42.jpg"])("%s is answered as the app's failure, not a static file", async (path) => {
    const res = await get("broken.test", path);
    expect(res.status).toBe(500);
    expect(res.body).not.toBe("panel robots");
  });
});
