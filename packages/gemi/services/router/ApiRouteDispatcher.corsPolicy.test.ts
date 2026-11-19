import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { CorsMiddleware } from "../../http/CorsMiddleware";
import type { CorsPolicy } from "../../http/corsPolicy";
import { RequestBreakerError } from "../../http/Error";
import { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { createFlatApiRoutes } from "./createFlatApiRoutes";

process.env.SECRET ??= "test-secret";

/**
 * #913: a route opts in to CORS with a `CorsPolicy` (`.cors()` on the route,
 * `cors` on its router). gemi answers its preflight and puts the headers on
 * every response, refusals included. Nothing else gets CORS headers, and
 * `Origin: null` never gets credentials.
 */

const SHOP = "https://shop.example";
const ran: string[] = [];

/** A widget's token check: refuses a request without the header. */
class RequiresToken extends Middleware {
  run() {
    ran.push("requires-token");
    if (!this.req.rawRequest.headers.get("x-widget-token")) {
      throw new RequestBreakerError("missing token");
    }
    return {};
  }
}

/** Echoes the shop's origin with credentials, as an app's `cors` middleware does. */
const ShopCors = CorsMiddleware.configure({ origins: { [SHOP]: {} } });
const NullCors = CorsMiddleware.configure({ origins: { null: {} } });

class WidgetApiRouter extends ApiRouter {
  // Unannotated, as an app writes it: `origins` is typed `string` for this.
  cors = { origins: "*", headers: ["content-type", "x-widget-token"] };
  middlewares = ["requires-token"];
  routes = {
    "/messages": {
      post: this.post(async (req = new HttpRequest()) => ({ echo: await req.input() })),
      get: this.get(() => ({ messages: [] })),
    },
    "/internal": this.post(() => ({ ok: true })).cors(false),
    "/nested": class extends ApiRouter {
      routes = { "/": this.post(() => ({ nested: true })) };
    },
    "/closed": class extends ApiRouter {
      cors = false;
      routes = { "/": this.post(() => ({ closed: true })) };
    },
  };
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/widget": WidgetApiRouter,
    "/plain": this.post(() => ({ ok: true })),
    "/account": this.post(() => ({ ok: true })).cors({ origins: [SHOP], credentials: true }),
    "/sandboxed": this.post(() => ({ ok: true })).cors({ origins: ["null", SHOP] }),
    "/single": this.post(() => ({ ok: true })).cors({ origins: SHOP }),
    "/both": this.post(() => ({ ok: true }))
      .middleware(["shop-cors"])
      .cors({ origins: "*" }),
    "/null-middleware": this.post(() => ({ ok: true })).middleware(["null-cors"]),
    "/narrow": {
      get: this.get(() => ({ ok: true })).cors({ origins: "*", methods: ["GET"] }),
      delete: this.delete(() => ({ ok: true })),
    },
  };
}

class TestKernel extends Kernel {
  config = {
    middleware: {
      aliases: { "requires-token": RequiresToken, "shop-cors": ShopCors, "null-cors": NullCors },
    },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {
          routes = { "/": this.view("Home", () => ({})) };
        },
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

function send(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return app.fetch(
    new Request(`http://gemi.dev/api${path}`, { method, headers, ...(body ? { body } : {}) }),
  ) as Promise<Response>;
}

function preflight(path: string, origin: string, method: string, requestHeaders?: string) {
  return send("OPTIONS", path, {
    Origin: origin,
    "Access-Control-Request-Method": method,
    ...(requestHeaders ? { "Access-Control-Request-Headers": requestHeaders } : {}),
  });
}

const fromSandbox = { Origin: "null" };

describe("preflight", () => {
  test("is answered from the router's policy for Origin: null, with no credentials", async () => {
    ran.length = 0;
    const res = await preflight("/widget/messages", "null", "POST", "content-type, x-widget-token");

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("content-type, x-widget-token");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    // A preflight carries no token: the router's middleware must not see it.
    expect(ran).toEqual([]);
  });

  test("a request header the policy does not list fails it", async () => {
    const res = await preflight("/widget/messages", "null", "POST", "content-type, authorization");

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
  });

  test("a method the path does not answer fails it", async () => {
    const res = await preflight("/widget/messages", "null", "DELETE");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("a method the policy narrows out fails it", async () => {
    expect((await preflight("/narrow", "null", "GET")).headers.get("Access-Control-Allow-Origin")).toBe("*");
    const res = await preflight("/narrow", "null", "DELETE");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("an origin a list does not name fails it", async () => {
    const res = await preflight("/account", "https://evil.example", "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  test("Origin: null fails a credentialed policy", async () => {
    const res = await preflight("/account", "null", "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("a listed origin gets its own origin and credentials", async () => {
    const res = await preflight("/account", SHOP, "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SHOP);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test.each(["/plain", "/widget/internal", "/widget/closed"])("%s, without a policy, gets no CORS headers", async (path) => {
    const res = await preflight(path, "null", "POST", "content-type");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  test("a nested router inherits its router's policy", async () => {
    const res = await preflight("/widget/nested", "null", "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("responses", () => {
  test("a route's answer to Origin: null allows any origin, without credentials", async () => {
    const res = await send(
      "POST",
      "/widget/messages",
      { ...fromSandbox, "x-widget-token": "t", "content-type": "application/json" },
      JSON.stringify({ text: "hi" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: { text: "hi" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("a middleware's refusal carries the headers, so the widget can read it", async () => {
    const res = await send("POST", "/widget/messages", fromSandbox, "{}");

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test.each(["/plain", "/widget/internal", "/widget/closed"])("%s, without a policy, gets none", async (path) => {
    const res = await send("POST", path, { ...fromSandbox, "x-widget-token": "t" }, "{}");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("an exact-origin policy echoes the origin with credentials and varies on it", async () => {
    const res = await send("POST", "/account", { Origin: SHOP }, "{}");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SHOP);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  test.each(["null", "https://evil.example"])("an exact-origin policy gives %s nothing", async (origin) => {
    const res = await send("POST", "/account", { Origin: origin }, "{}");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("a single origin is an exact-origin policy", async () => {
    expect((await send("POST", "/single", { Origin: SHOP }, "{}")).headers.get("Access-Control-Allow-Origin")).toBe(SHOP);
    expect((await send("POST", "/single", fromSandbox, "{}")).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test('"null" in a list is echoed, never with credentials', async () => {
    const res = await send("POST", "/sandboxed", fromSandbox, "{}");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("the route's policy replaces a cors middleware's credentials", async () => {
    const res = await send("POST", "/both", { Origin: SHOP }, "{}");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("CorsMiddleware and Origin: null", () => {
  test('a "null" key never sends credentials', async () => {
    const res = await send("POST", "/null-middleware", fromSandbox, "{}");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("a policy gemi cannot answer safely is refused when declared", () => {
  const route = () => new ApiRouter().post(() => ({}));

  test.each<[string, CorsPolicy]>([
    ["credentials with *", { origins: "*", credentials: true }],
    ["credentials with null", { origins: ["null", SHOP], credentials: true }],
    ["* inside a list", { origins: ["*"] }],
    ["an empty list", { origins: [] }],
    ["a url with a path", { origins: ["https://shop.example/store"] }],
    ["a single string that is not an origin", { origins: "shop.example" }],
    ["credentials with a single null", { origins: "null", credentials: true }],
    ["a bad header name", { origins: "*", headers: ["x token"] }],
    ["a bad maxAge", { origins: "*", maxAge: -1 }],
  ])("%s", (_, policy) => {
    expect(() => route().cors(policy)).toThrow(/CORS policy/);
  });

  test("on a router too, when its routes are flattened", () => {
    class Bad extends ApiRouter {
      cors: CorsPolicy = { origins: "*", credentials: true };
      routes = { "/": this.post(() => ({})) };
    }
    expect(() => createFlatApiRoutes({ "/bad": Bad })).toThrow(/CORS policy on the router at "\/bad"/);
  });

  test("`cors = true` is not a policy", () => {
    class Bad extends ApiRouter {
      cors = true;
      routes = { "/": this.post(() => ({})) };
    }
    expect(() => createFlatApiRoutes({ "/bad": Bad })).toThrow(/is not a policy/);
  });
});
