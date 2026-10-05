import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { RequestBreakerError } from "../../http/Error";
import { FileNotFoundError } from "../../http/errors";
import type { HttpRequest } from "../../http/HttpRequest";
import { defineResourcePolicy } from "../../http/ResourcePolicy";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A resource policy through a whole `App` (#726): its middleware on api and
 * view routes, the resource a handler gets back from it, and what a view
 * route renders for a refusal.
 */

process.env.SECRET ??= "resource-policy-routes-test-secret";

type Page = { id: string; ownerId: string; title: string };

const PAGES: Record<string, Page> = {
  p1: { id: "p1", ownerId: "alice", title: "Alice's page" },
  p2: { id: "p2", ownerId: "bob", title: "Bob's page" },
};

const loads: string[] = [];
const failed: unknown[] = [];

const PagePolicy = defineResourcePolicy({
  param: "pageId",
  load: (id) => {
    loads.push(id);
    return PAGES[id] ?? null;
  },
  // The caller, from a header, standing in for `Auth.user()`.
  allow: (page, req) => page.ownerId === req.headers.get("x-user"),
});

class PagesRouter extends ApiRouter {
  middlewares = ["owns-page"];
  routes = {
    "/": this.get(() => ({ pages: Object.keys(PAGES) })).middleware(["-owns-page"]),
    "/:pageId": this.get(async () => {
      // The middleware's answer, not a second load.
      const page = await PagePolicy.fromRoute();
      return { title: page.title };
    }),
  };
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/pages": PagesRouter,
    // Another param name, from the middleware's entry.
    "/legacy/:id": this.get(() => ({ ok: true })).middleware(["owns-page:id"]),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/pages/:pageId": this.view("PageBuilder", async (req: HttpRequest<any, any>) => ({
      PageBuilder: { title: (await PagePolicy.fromRoute(req)).title },
    })),
    "/guarded/:pageId": this.view("Guarded", () => ({ Guarded: {} })).middleware(["owns-page"]),
    "/file": this.view("File", () => {
      throw new FileNotFoundError("a.txt");
    }),
    "/taken": this.view("Taken", () => {
      throw new RequestBreakerError("This slug is taken", { status: 409 });
    }),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { "owns-page": PagePolicy.middleware } },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
        onRequestFail: (_req: HttpRequest, error: unknown) => {
          failed.push(error);
        },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

const as = (user: string) => ({ "x-user": user });

async function api(path: string, user: string) {
  return (await app.fetch(
    new Request(`http://gemi.dev/api${path}`, { headers: as(user) }),
  )) as Response;
}

const renderParams = {
  getStyles: async () => [],
  viewImportMap: {},
  bootstrapModules: [],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

async function page(path: string, user = "nobody") {
  const result = await app.fetch(new Request(`http://gemi.dev${path}`, { headers: as(user) }));
  if (result instanceof Response) return result;
  expect(typeof result).toBe("function");
  return (await (result as any)(renderParams)) as Response;
}

async function navigate(path: string, user = "nobody") {
  const res = (await app.fetch(
    new Request(`http://gemi.dev${path}.json`, { headers: as(user) }),
  )) as Response;
  expect(res).toBeInstanceOf(Response);
  return res;
}

beforeEach(() => {
  loads.length = 0;
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("on api routes", () => {
  test("the owner gets the resource, loaded once for the middleware and the handler", async () => {
    const res = await api("/pages/p1", "alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Alice's page" });
    expect(loads).toEqual(["p1"]);
  });

  test("someone else's resource and a missing one get the same 404", async () => {
    const theirs = await api("/pages/p2", "alice");
    const missing = await api("/pages/nope", "alice");
    for (const res of [theirs, missing]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: { kind: "not_found", message: "Not found", status: 404 },
      });
    }
  });

  test("-owns-page opts a route out of its router's middleware", async () => {
    const res = await api("/pages", "nobody");
    expect(res.status).toBe(200);
    expect(loads).toEqual([]);
  });

  test("owns-page:id reads the param id", async () => {
    expect((await api("/legacy/p2", "bob")).status).toBe(200);
    expect((await api("/legacy/p2", "alice")).status).toBe(404);
  });
});

describe("on view routes, a refusal renders the app's 404 view", () => {
  test("a page load gets the 404 view under the refusal's status", async () => {
    for (const path of ["/pages/p2", "/pages/nope", "/guarded/p2"]) {
      const res = await page(path, "alice");
      const html = await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(html).toContain('"is404":true');
      expect(html).not.toContain("Bob's page");
    }
  });

  test("a navigation gets is404, so the client router shows the 404 view", async () => {
    for (const path of ["/pages/p2", "/guarded/p2"]) {
      const res = await navigate(path, "alice");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text.split("\n")[0]).is404).toBe(true);
      expect(text).not.toContain("Bob's page");
    }
  });

  test("the owner gets the page", async () => {
    const res = await page("/pages/p1", "alice");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice's page");
    expect((await page("/guarded/p1", "alice")).status).toBe(200);
  });

  test("a refusal is not reported as a failure", async () => {
    await page("/pages/p2", "alice");
    await navigate("/guarded/p2", "alice");
    expect(failed).toEqual([]);
  });

  test("FileNotFoundError renders the 404 view too, where it was an empty 400", async () => {
    const res = await page("/file");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('"is404":true');
  });

  test("a breaker with another status keeps its own answer", async () => {
    const res = await page("/taken");
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain("is404");
  });
});
