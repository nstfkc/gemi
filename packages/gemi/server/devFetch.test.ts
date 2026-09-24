import { createElement } from "react";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { RequestBreakerError } from "../http/Error";
import { Middleware } from "../http/Middleware";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { createDevFetch } from "./devFetch";

/**
 * The dev server's request handling, driven without `Bun.serve` or a real Vite.
 * What stands in for Vite is its Connect stack, `vite.middlewares`: the real
 * adapter that runs a `Request` through it is under test, and the stub decides
 * which paths Vite owns, as `appType: "custom"` does by calling `next()` for
 * everything else.
 */

let ran = 0;
let crash = false;

class NotThroughFrontDoor extends RequestBreakerError {
  constructor() {
    super("not through the front door");
    this.payload = {
      api: { status: 403, data: { error: "direct origin access" } },
      view: { status: 403, error: { message: "direct origin access" } },
    };
  }
}

class FrontDoor extends Middleware {
  run() {
    ran++;
    if (crash) {
      throw new Error("the gate fell over");
    }
    if (this.req.headers.get("x-azure-fdid") !== "fd-1") {
      throw new NotThroughFrontDoor();
    }
    this.req.ctx().setHeaders("X-Gate", "front-door");
  }
}

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { "front-door": FrontDoor }, global: ["front-door"] },
    route: {
      api: {
        rootRouter: class extends ApiRouter {
          routes = { "/ping": this.get(() => ({ ok: true })) };
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const VITE_CLIENT = "// the vite client\n";
const THROUGH_FRONT_DOOR = { "x-azure-fdid": "fd-1" };

/** The paths Vite answered, in order. */
let viteServed: string[] = [];

const vite = {
  middlewares: (req: any, res: any, next: () => void) => {
    if (req.url === "/@vite/client") {
      viteServed.push(req.url);
      res.setHeader("Content-Type", "text/javascript");
      res.end(VITE_CLIENT);
      return;
    }
    next();
  },
  ws: { send: vi.fn() },
  ssrFixStacktrace: vi.fn(),
  moduleGraph: { getModulesByFile: () => undefined },
} as unknown as ViteDevServer;

let devFetch: (req: Request) => Promise<Response>;
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.SECRET ??= "test-secret";
  // A crashing gate is logged, as any request error in dev is.
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = new App({ kernel: AppKernel });
  devFetch = createDevFetch(app, (req, next) => next(req), vite);
});

afterAll(() => {
  process.env = savedEnv;
  vi.restoreAllMocks();
  delete globalThis.__gemiErrorPageServed;
});

beforeEach(() => {
  ran = 0;
  crash = false;
  viteServed = [];
});

function get(path: string, headers: Record<string, string> = {}) {
  return devFetch(new Request(`http://localhost:5173${path}`, { headers }));
}

describe("the dev server with a global middleware", () => {
  test("refuses what Vite serves, before Vite sees it", async () => {
    const res = await get("/@vite/client");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("direct origin access");
    expect(viteServed).toEqual([]);
    expect(ran).toBe(1);
  });

  test("serves what Vite serves once it passes, with the headers it set", async () => {
    const res = await get("/@vite/client", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(VITE_CLIENT);
    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(viteServed).toEqual(["/@vite/client"]);
    expect(ran).toBe(1);
  });

  test.each(["/refresh.js", "/render-error.js"])("gates the dev script %s", async (path) => {
    const refused = await get(path);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("direct origin access");

    const res = await get(path, THROUGH_FRONT_DOOR);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/javascript");
    expect(res.headers.get("X-Gate")).toBe("front-door");
  });

  test("hands what Vite does not own to the app, and runs the list once", async () => {
    const refused = await get("/api/ping");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "direct origin access" });

    ran = 0;
    const res = await get("/api/ping", THROUGH_FRONT_DOOR);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(ran).toBe(1);
  });

  test("renders a document through the gate, with its headers", async () => {
    const res = await get("/nowhere", THROUGH_FRONT_DOOR);

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(ran).toBe(1);
  });

  test("answers a gate that crashed with the dev error page, and serves nothing", async () => {
    crash = true;

    const page = await get("/@vite/client", THROUGH_FRONT_DOOR);
    expect(page.status).toBe(500);
    expect(page.headers.get("Content-Type")).toBe("text/html");
    expect(await page.text()).toContain("the gate fell over");
    expect(viteServed).toEqual([]);

    const api = await get("/api/ping", THROUGH_FRONT_DOOR);
    expect(api.status).toBe(500);
    expect(await api.json()).toEqual({ error: "the gate fell over" });
  });
});
