import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { createDevFetch } from "./devFetch";

/**
 * #1015 in dev: Vite serves `public/` on every host, so a host whose views set
 * `publicFiles: false` is routed around it, as `gemi start` does. The stub
 * stands in for Vite's public-dir middleware.
 */

class ShopViewRouter extends ViewRouter {
  routes = {
    "/robots.txt": this.file(() => new File(["shop robots"], "robots.txt", { type: "text/plain" })),
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
        rootRouter: class extends ViewRouter {},
      },
      domains: {
        root: "example.test",
        trustProxy: true,
        groups: [{ subdomain: ":shop", view: { rootRouter: ShopViewRouter, publicFiles: false } }],
      },
    },
  };
}

let publicDir: string;
let devFetch: (req: Request) => Promise<Response>;
const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.SECRET ??= "test-secret";
  publicDir = await mkdtemp(join(tmpdir(), "gemi-dev-public-"));
  await writeFile(join(publicDir, "robots.txt"), "panel robots");
  const vite = {
    config: { publicDir },
    middlewares: async (req: any, res: any, next: () => void) => {
      try {
        res.end(await readFile(join(publicDir, req.url)));
      } catch {
        next();
      }
    },
    ws: { send: vi.fn() },
    ssrFixStacktrace: vi.fn(),
    moduleGraph: { getModulesByFile: () => undefined },
  } as unknown as ViteDevServer;
  devFetch = createDevFetch(new App({ kernel: AppKernel }), (req, next) => next(req), vite);
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(publicDir, { recursive: true, force: true });
});

async function get(host: string, path: string) {
  const res = await devFetch(
    new Request(`http://localhost:5173${path}`, { headers: { "x-forwarded-host": host } }),
  );
  return { status: res.status, body: await res.text() };
}

describe("the dev server: public/ files per host (#1015)", () => {
  test("the root host gets the file Vite serves", async () => {
    expect((await get("example.test", "/robots.txt")).body).toBe("panel robots");
  });

  test("a group with publicFiles: false gets its own route", async () => {
    const res = await get("acme.example.test", "/robots.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("shop robots");
  });
});
