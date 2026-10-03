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
import {
  createDevFetch,
  DEV_ENTRY_PATH,
  DEV_ENTRY_SOURCE,
  REFRESH_PREAMBLE_SOURCE,
} from "./devFetch";

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

  test.each(["/refresh.js", "/render-error.js", DEV_ENTRY_PATH])("gates the dev script %s", async (path) => {
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
    expect(await api.json()).toEqual({ error: { kind: "server_error", message: "the gate fell over", status: 500 } });
  });
});

/**
 * #733: the React Refresh preamble has to load from wherever the page did, and
 * has to have run before any component module evaluates. Otherwise every
 * component throws "@vitejs/plugin-react can't detect preamble" and the page
 * never hydrates — which is what happened behind an https tunnel.
 */
describe("the React Refresh preamble", () => {
  test("imports the runtime by an origin-relative URL, whatever the request's origin", async () => {
    // What the server sees behind a TLS-terminating tunnel: plain http, and
    // possibly its own localhost address rather than the tunnel's host.
    const res = await devFetch(
      new Request("http://localhost:5173/refresh.js", { headers: THROUGH_FRONT_DOOR }),
    );
    const source = await res.text();

    expect(source).toBe(REFRESH_PREAMBLE_SOURCE);
    expect(source).toContain('import RefreshRuntime from "/@react-refresh";');
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain("localhost");
  });

  test("installs everything plugin-react's transform checks for", () => {
    expect(REFRESH_PREAMBLE_SOURCE).toContain("RefreshRuntime.injectIntoGlobalHook(window)");
    expect(REFRESH_PREAMBLE_SOURCE).toContain("window.$RefreshReg$ =");
    expect(REFRESH_PREAMBLE_SOURCE).toContain("window.$RefreshSig$ =");
    expect(REFRESH_PREAMBLE_SOURCE).toContain("window.__vite_plugin_react_preamble_installed__ = true");
  });

  test("the dev entry runs the preamble, then the HMR client, then the app, each awaited", async () => {
    const res = await get(DEV_ENTRY_PATH, THROUGH_FRONT_DOOR);
    const source = await res.text();
    expect(source).toBe(DEV_ENTRY_SOURCE);

    const lines = source.split("\n").filter((line) => line.includes("import("));
    expect(lines).toEqual([
      'await import("/refresh.js").catch(report);',
      'await import("/@vite/client").catch(report);',
      'await import("/app/client.tsx");',
    ]);
  });

  test("the dev entry really does finish the preamble before the app starts", async () => {
    // Run the entry with a stand-in `import()` whose preamble resolves last:
    // with async `<script type="module">` tags, that is the load order in
    // which the app evaluated without a preamble.
    const order: string[] = [];
    const delays: Record<string, number> = { "/refresh.js": 30, "/@vite/client": 10, "/app/client.tsx": 0 };
    const load = (path: string) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push(path);
          resolve();
        }, delays[path]),
      );
    const body = DEV_ENTRY_SOURCE.replaceAll("await import(", "await load(");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("load", "console", body)(load, console);

    expect(order).toEqual(["/refresh.js", "/@vite/client", "/app/client.tsx"]);
  });

  test("a document boots through the one ordered entry, not separate async scripts", async () => {
    const res = await get("/nowhere", THROUGH_FRONT_DOOR);
    const html = await res.text();

    expect(html).toContain(`src="${DEV_ENTRY_PATH}"`);
    expect(html).not.toContain('src="/refresh.js"');
    expect(html).not.toContain('src="/app/client.tsx"');
    expect(html).not.toContain('src="/@vite/client"');
  });
});
