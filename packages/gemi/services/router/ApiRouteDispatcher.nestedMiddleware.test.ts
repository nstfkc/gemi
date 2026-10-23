import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { CacheMiddleware } from "../../http/CacheMiddleware";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * #1022, end to end: a nested api router's routes run every enclosing router's
 * `middlewares` before its own and the route's, in that order, and a `-alias`
 * further down removes an inherited one. Mounting under a `(group)` adds no
 * path segment.
 */

const ran: string[] = [];

function recorder(name: string) {
  return class extends Middleware {
    run() {
      ran.push(name);
      return {};
    }
  };
}

class Builds extends ApiRouter {
  middlewares = ["builds"];
  routes = {
    "/:pageId/builds/:buildId": this.get(() => ({ ok: true })).middleware(["route"]),
  };
}

class Pages extends ApiRouter {
  middlewares = ["page-owner"];
  routes = {
    "/:pageId": this.get(() => ({ ok: true })),
    "/(builds)": Builds,
    "/:pageId/public": this.get(() => ({ ok: true })).middleware(["-page-owner", "-cache"]),
  };
}

class RootApiRouter extends ApiRouter {
  middlewares = ["cache:private"];
  routes = {
    "/projects": this.get(() => ({ ok: true })),
    "/pages": Pages,
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: {
        cache: CacheMiddleware,
        "page-owner": recorder("page-owner"),
        builds: recorder("builds"),
        route: recorder("route"),
      },
    },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });
const privateCache = "private, max-age=0, stale-while-revalidate=300, stale-if-error=600";

beforeEach(() => {
  ran.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nested api routers inherit middlewares (#1022)", () => {
  test("the root router's cache reaches its direct routes", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/projects"));

    expect([res.status, res.headers.get("Cache-Control")]).toEqual([200, privateCache]);
  });

  test("and a nested router's routes, before the nested router's own", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/pages/1"));

    expect([res.status, res.headers.get("Cache-Control")]).toEqual([200, privateCache]);
    expect(ran).toEqual(["page-owner"]);
  });

  test("a route under a group runs every level in order, the route's last", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/pages/1/builds/2"));

    expect([res.status, res.headers.get("Cache-Control")]).toEqual([200, privateCache]);
    expect(ran).toEqual(["page-owner", "builds", "route"]);
  });

  test("the group's literal path is not served", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/pages/(builds)/1/builds/2"));

    expect(res.status).toBe(404);
  });

  test("a route's `-alias` removes an inherited middleware", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/pages/1/public"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(ran).toEqual([]);
  });
});
