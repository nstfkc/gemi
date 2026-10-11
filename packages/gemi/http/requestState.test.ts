process.env.SECRET ??= "request-state-test-secret";

import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ApiRouter } from "./ApiRouter";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";
import { MissingRequestStateError, RequestState, stateKey } from "./requestState";
import { ViewRouter } from "./ViewRouter";

/**
 * #887: typed values kept for one request, set by a middleware and read by
 * the handler, without a `WeakMap<HttpRequest, ...>` keyed on whichever
 * `HttpRequest` instance happened to be passed along.
 */

type Scope = { kind: "site"; siteId: string };

const scope = stateKey<Scope>("scope");
const tenant = stateKey<string>("tenant");
const visits = stateKey<number>("visits");

describe("RequestState", () => {
  test("get, require, set, has and delete", () => {
    const state = new RequestState();

    expect(state.get(scope)).toBeUndefined();
    expect(state.has(scope)).toBe(false);
    expect(state.set(scope, { kind: "site", siteId: "s1" })).toEqual({
      kind: "site",
      siteId: "s1",
    });
    expect(state.require(scope)).toEqual({ kind: "site", siteId: "s1" });
    expect(state.has(scope)).toBe(true);
    expect(state.delete(scope)).toBe(true);
    expect(state.has(scope)).toBe(false);
  });

  test("require names the missing key", () => {
    const state = new RequestState();

    expect(() => state.require(scope)).toThrow(MissingRequestStateError);
    expect(() => state.require(scope)).toThrow(/"scope"/);
  });

  test("a value that is set, even to undefined, is found by require", () => {
    const maybe = stateKey<string | undefined>("maybe");
    const state = new RequestState();
    state.set(maybe, undefined);

    expect(state.require(maybe)).toBeUndefined();
  });

  test("keys compare by identity, not by name", () => {
    const one = stateKey<number>("same");
    const other = stateKey<number>("same");
    const state = new RequestState();
    state.set(one, 1);

    expect(state.get(other)).toBeUndefined();
  });

  test("carry copies what the route has not set itself", () => {
    const from = new RequestState();
    from.set(tenant, "acme");
    from.set(visits, 1);
    const to = new RequestState();
    to.set(visits, 2);

    RequestState.carry(from, to);

    expect(to.get(tenant)).toBe("acme");
    expect(to.get(visits)).toBe(2);
  });
});

describe("HttpRequest.state", () => {
  test("a request built with a Request has its own state", () => {
    const a = new HttpRequest(new Request("http://gemi.dev/a"), {}, "api", "/a");
    const b = new HttpRequest(new Request("http://gemi.dev/b"), {}, "api", "/b");
    a.state.set(tenant, "acme");

    expect(b.state.get(tenant)).toBeUndefined();
  });
});

/** Resolves the scope once, from the route's param. */
class SiteScope extends Middleware {
  run() {
    const { siteId } = this.req.params as { siteId: string };
    if (siteId) {
      this.req.state.set(scope, { kind: "site", siteId });
    }
    this.req.state.set(visits, (this.req.state.get(visits) ?? 0) + 1);
  }
}

/** A global middleware: the list runs in a request scope of its own. */
class Tenant extends Middleware {
  run() {
    const name = this.req.headers.get("x-tenant");
    if (name) {
      this.req.state.set(tenant, name);
    }
  }
}

class ShowSiteRequest extends HttpRequest<{}, { siteId: string }> {}

class RootApiRouter extends ApiRouter {
  routes = {
    "/sites/:siteId": this.get(async () => {
      const req = new HttpRequest<{}, { siteId: string }>();
      return {
        scope: req.state.require(scope),
        tenant: req.state.get(tenant) ?? null,
        visits: req.state.get(visits),
      };
    }).middleware(["site-scope"]),
    "/custom/:siteId": this.get(async () => {
      const req = new ShowSiteRequest();
      return { siteId: req.state.require(scope).siteId };
    }).middleware(["site-scope"]),
    "/unscoped": this.get(async () => {
      const req = new HttpRequest();
      return { scope: req.state.require(scope) };
    }),
    "/peek": this.get(async () => {
      const req = new HttpRequest();
      return { scope: req.state.get(scope) ?? null, tenant: req.state.get(tenant) ?? null };
    }),
  };
}

class RootViewRouter extends ViewRouter {
  middlewares = ["site-scope"];
  routes = {
    "/sites/:siteId": this.view("Site", async () => {
      const req = new HttpRequest<{}, { siteId: string }>();
      return { siteId: req.state.require(scope).siteId };
    }),
  };
}

const app = new App({
  kernel: class extends Kernel {
    config = {
      middleware: {
        aliases: { "site-scope": SiteScope, tenant: Tenant },
        global: ["tenant"],
      },
      route: {
        api: { rootRouter: RootApiRouter },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: RootViewRouter,
        },
      },
    };
  },
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://gemi.dev/api${path}`, { headers }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("set by a middleware, read by the handler (#887)", () => {
  test("the handler's own HttpRequest reads what the middleware set", async () => {
    expect(await get("/sites/s1")).toEqual({
      status: 200,
      body: { scope: { kind: "site", siteId: "s1" }, tenant: null, visits: 1 },
    });
  });

  test("a custom request class reads it too", async () => {
    expect(await get("/custom/s2")).toEqual({ status: 200, body: { siteId: "s2" } });
  });

  test("require on a route without the middleware throws, which the server answers as a 500", async () => {
    await expect(app.fetch(new Request("http://gemi.dev/api/unscoped"))).rejects.toThrow(
      MissingRequestStateError,
    );
  });

  test("a value is not carried to the next request", async () => {
    await get("/sites/s1");

    expect(await get("/peek")).toEqual({ status: 200, body: { scope: null, tenant: null } });
  });

  test("what a global middleware set reaches the route", async () => {
    expect(await get("/sites/s3", { "x-tenant": "acme" })).toEqual({
      status: 200,
      body: { scope: { kind: "site", siteId: "s3" }, tenant: "acme", visits: 1 },
    });
  });

  test("a view loader reads what the view router's middleware set", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/sites/s4.json"));

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('"siteId":"s4"');
  });
});
