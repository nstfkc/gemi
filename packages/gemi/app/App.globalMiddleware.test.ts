import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { RequestBreakerError } from "../http/Error";
import { HttpRequest } from "../http/HttpRequest";
import { Middleware } from "../http/Middleware";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";

process.env.SECRET ??= "test-secret";

/**
 * The `global` middleware list (#550): it runs once for every request, in
 * order, before the router and before any route middleware, and a break from
 * it ends the request with that break's response.
 */

const ran: string[] = [];
const handled: string[] = [];

class NotThroughFrontDoor extends RequestBreakerError {
  constructor() {
    super("not through the front door");
    this.payload = {
      api: { status: 403, data: { error: "direct origin access" } },
      view: { status: 403, error: { message: "direct origin access" } },
    };
  }
}

/** The Front Door check #550 was filed for. */
class FrontDoor extends Middleware {
  run() {
    ran.push("front-door");
    if (this.req.headers.get("x-azure-fdid") !== "fd-1") {
      throw new NotThroughFrontDoor();
    }
    this.req.ctx().setHeaders("X-Gate", "front-door");
    this.req.ctx().setHeaders("X-Shared", "global");
  }
}

class Tag extends Middleware {
  run(...args: string[]) {
    ran.push(`tag:${args.join(",")}`);
  }
}

class Explodes extends Middleware {
  run() {
    ran.push("explodes");
    throw new Error("gate crashed");
  }
}

class RouteTag extends Middleware {
  run() {
    ran.push("route");
    this.req.ctx().setHeaders("X-Shared", "route");
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/orders": this.get(() => {
      handled.push("/orders");
      return { ok: true };
    }).middleware(["route-tag"]),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => {
      handled.push("/");
      return {};
    }),
  };
}

const route = {
  api: { rootRouter: RootApiRouter },
  view: {
    root: createRoot(() => createElement("div")),
    rootRouter: RootViewRouter,
  },
};

function kernelWith(global: any[]) {
  return class extends Kernel {
    config = {
      middleware: {
        aliases: { "front-door": FrontDoor, tag: Tag, "route-tag": RouteTag, explodes: Explodes },
        global,
      },
      route,
    };
  };
}

const app = new App({ kernel: kernelWith(["tag:a,b", "front-door"]) });
const kernel = (app as any).kernel as Kernel;

const THROUGH_FRONT_DOOR = { "x-azure-fdid": "fd-1" };

beforeEach(() => {
  ran.length = 0;
  handled.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("global middleware", () => {
  test("refuses an api route with the break's api payload, and the route never runs", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/orders"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "direct origin access" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(handled).toEqual([]);
    expect(ran).toEqual(["tag:a,b", "front-door"]);
  });

  test("refuses an api path no route matches, instead of answering its 404", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/nowhere"));

    expect(res.status).toBe(403);
  });

  test("refuses a framework route under /__gemi__", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/__gemi__/debug/api-routes"));

    expect(res.status).toBe(403);
  });

  test("refuses a view route with the break's view payload", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/"));

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("direct origin access");
    expect(handled).toEqual([]);
  });

  test("refuses a .json navigation with the body the client router reads", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/.json"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ data: { error: "direct origin access" } });
    expect(handled).toEqual([]);
  });

  test("runs in order, before route middleware, and once", async () => {
    const res = await app.fetch(
      new Request("http://gemi.dev/api/orders", { headers: THROUGH_FRONT_DOOR }),
    );

    expect(res.status).toBe(200);
    expect(handled).toEqual(["/orders"]);
    expect(ran).toEqual(["tag:a,b", "front-door", "route"]);
  });

  test("puts the headers it set on the response, and the route's own win", async () => {
    const res = await app.fetch(
      new Request("http://gemi.dev/api/orders", { headers: THROUGH_FRONT_DOOR }),
    );

    expect(res.headers.get("X-Gate")).toBe("front-door");
    expect(res.headers.get("X-Shared")).toBe("route");
  });

  test("puts its headers on a rendered document too", async () => {
    const render = await app.fetch(
      new Request("http://gemi.dev/", { headers: THROUGH_FRONT_DOOR }),
    );

    expect(typeof render).toBe("function");
    const res: Response = await (render as any)({
      getStyles: async () => [],
      viewImportMap: {},
      viewModules: {},
      loaders: "{}",
      cssManifest: {},
      ogMap: {},
    });
    expect(res.headers.get("X-Gate")).toBe("front-door");
  });

  test("a request the server already gated is not gated again by fetch", async () => {
    const req = new Request("http://gemi.dev/api/orders", { headers: THROUGH_FRONT_DOOR });
    const res = await app.withGlobalMiddleware(
      req,
      (r) => app.fetch(r),
      () => {
        throw new Error("unreachable");
      },
    );

    expect(res.status).toBe(200);
    expect(ran).toEqual(["tag:a,b", "front-door", "route"]);
    expect(res.headers.get("X-Gate")).toBe("front-door");
  });

  test("a refusal in front of the server's handler never calls it", async () => {
    const next = vi.fn(async () => new Response("static file"));
    const res = await app.withGlobalMiddleware(
      new Request("http://gemi.dev/assets/app.js"),
      next,
      () => new Response("error", { status: 500 }),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("direct origin access");
    expect(next).not.toHaveBeenCalled();
  });

  test("an in-process dispatchAs is not gated: its request already was", async () => {
    const initiator = new HttpRequest(new Request("http://gemi.dev/api/agent"), {});
    const res = await kernel.run(() => kernel.apiRoutes().dispatchAs(initiator, "GET", "/orders"));

    expect(res.status).toBe(200);
    expect(ran).toEqual(["route"]);
  });
});

describe("a global middleware that throws", () => {
  const crashing = new App({ kernel: kernelWith(["explodes"]) });

  test("in front of the server's handler goes to onError, not through to a static file", async () => {
    const next = vi.fn(async () => new Response("static file"));
    const res = await crashing.withGlobalMiddleware(
      new Request("http://gemi.dev/assets/app.js"),
      next,
      (err) => new Response((err as Error).message, { status: 500 }),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("gate crashed");
    expect(next).not.toHaveBeenCalled();
  });

  test("from fetch is thrown, as a route's crash is", async () => {
    await expect(crashing.fetch(new Request("http://gemi.dev/api/orders"))).rejects.toThrow(
      "gate crashed",
    );
    expect(handled).toEqual([]);
  });
});

describe("the global list at boot", () => {
  test("an alias that is not registered stops the boot", async () => {
    const bad = new App({ kernel: kernelWith(["front-dor"]) });
    await expect(bad.waitForBoot()).rejects.toThrow(/"front-dor" is not a registered alias/);
  });

  test("a -alias stops the boot: there is nothing to cancel", async () => {
    const bad = new App({ kernel: kernelWith(["-front-door"]) });
    await expect(bad.waitForBoot()).rejects.toThrow(/cancels an alias/);
  });

  test("a class needs no alias", async () => {
    const ok = new App({ kernel: kernelWith([Tag]) });
    await ok.waitForBoot();
    const res = await ok.fetch(new Request("http://gemi.dev/api/orders"));

    expect(res.status).toBe(200);
    expect(ran).toEqual(["tag:", "route"]);
  });
});
