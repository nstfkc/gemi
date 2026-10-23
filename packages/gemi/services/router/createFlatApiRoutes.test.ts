import { describe, test, expect } from "vitest";

import { createFlatApiRoutes, removeApiGroupSegments } from "./createFlatApiRoutes";
import { ApiRouter } from "../../http/ApiRouter";
import { Controller, ResourceController } from "../../http/Controller";
import { AgentController } from "../../ai/AgentController";

class ProductController extends ResourceController {
  list() {
    return [];
  }
  store() {
    return {};
  }
  show() {
    return {};
  }
  update() {
    return {};
  }
  delete() {
    return {};
  }
}

function middlewaresOf(routes: ReturnType<typeof createFlatApiRoutes>) {
  return Object.fromEntries(
    Object.entries(routes).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, handler]) => [
        `${method} ${path}`,
        handler.middleware,
      ]),
    ),
  );
}

describe("createFlatApiRoutes() resource middleware", () => {
  test("attaches per-action middleware to the matching routes", () => {
    class Root extends ApiRouter {
      routes = {
        "/products/:productId": this.resource(ProductController).middleware({
          list: ["cache"],
          store: ["auth"],
          show: ["cache"],
          update: ["auth", "admin"],
          delete: ["auth", "admin"],
        }),
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes));

    expect(middlewares["GET /products"]).toEqual(["cache"]);
    expect(middlewares["POST /products"]).toEqual(["auth"]);
    expect(middlewares["GET /products/:productId"]).toEqual(["cache"]);
    expect(middlewares["PUT /products/:productId"]).toEqual(["auth", "admin"]);
    expect(middlewares["DELETE /products/:productId"]).toEqual([
      "auth",
      "admin",
    ]);
  });

  test("only configured actions receive middleware", () => {
    class Root extends ApiRouter {
      routes = {
        "/products/:productId": this.resource(ProductController).middleware({
          store: ["auth"],
        }),
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes));

    expect(middlewares["POST /products"]).toEqual(["auth"]);
    expect(middlewares["GET /products"]).toEqual([]);
    expect(middlewares["GET /products/:productId"]).toEqual([]);
    expect(middlewares["PUT /products/:productId"]).toEqual([]);
    expect(middlewares["DELETE /products/:productId"]).toEqual([]);
  });

  test("resource without middleware has no middleware", () => {
    class Root extends ApiRouter {
      routes = {
        "/products/:productId": this.resource(ProductController),
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes));

    expect(middlewares["GET /products"]).toEqual([]);
    expect(middlewares["POST /products"]).toEqual([]);
    expect(middlewares["GET /products/:productId"]).toEqual([]);
    expect(middlewares["PUT /products/:productId"]).toEqual([]);
    expect(middlewares["DELETE /products/:productId"]).toEqual([]);
  });

  test("router-level middleware is merged before per-action middleware", () => {
    class Root extends ApiRouter {
      routes = {
        "/products/:productId": this.resource(ProductController).middleware({
          store: ["auth"],
        }),
      };
    }

    const middlewares = middlewaresOf(
      createFlatApiRoutes(new Root().routes, "", ["cors"]),
    );

    expect(middlewares["POST /products"]).toEqual(["cors", "auth"]);
    expect(middlewares["GET /products"]).toEqual(["cors"]);
  });
});

describe("createFlatApiRoutes - stream routes", () => {
  test("registers GET, HEAD and OPTIONS", () => {
    class Root extends ApiRouter {
      routes = {
        "/video": this.stream(() => null),
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);

    expect(Object.keys(routes["/video"]).sort()).toEqual([
      "GET",
      "HEAD",
      "OPTIONS",
    ]);
  });

  test("propagates middleware to both GET and HEAD", () => {
    class Root extends ApiRouter {
      routes = {
        "/video": this.stream(() => null).middleware(["auth"]),
      };
    }

    const middlewares = middlewaresOf(
      createFlatApiRoutes(new Root().routes, "", ["cors"]),
    );

    expect(middlewares["GET /video"]).toEqual(["cors", "auth"]);
    expect(middlewares["HEAD /video"]).toEqual(["cors", "auth"]);
  });

  test("a plain file route stays GET only", () => {
    class Root extends ApiRouter {
      routes = {
        "/download": this.file(() => null),
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);

    expect(Object.keys(routes["/download"]).sort()).toEqual(["GET", "OPTIONS"]);
  });
});

describe("createFlatApiRoutes - verb maps (#707)", () => {
  test("a stream get shares its path with other verbs and keeps its HEAD", () => {
    class Root extends ApiRouter {
      routes = {
        "/files/:fileId": {
          get: this.stream(() => null).middleware(["auth"]),
          delete: this.delete(() => ({ ok: true })).middleware(["admin"]),
        },
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);
    expect(Object.keys(routes["/files/:fileId"]).sort()).toEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
    ]);

    const middlewares = middlewaresOf(routes);
    expect(middlewares["GET /files/:fileId"]).toEqual(["auth"]);
    expect(middlewares["HEAD /files/:fileId"]).toEqual(["auth"]);
    expect(middlewares["DELETE /files/:fileId"]).toEqual(["admin"]);
  });

  test("a file get shares its path too, GET only", () => {
    class Root extends ApiRouter {
      routes = {
        "/report": {
          get: this.file(() => null),
          post: this.post(() => ({ ok: true })),
        },
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);
    expect(Object.keys(routes["/report"]).sort()).toEqual(["GET", "OPTIONS", "POST"]);
  });

  test("a plain get in a verb map gets no HEAD", () => {
    class Root extends ApiRouter {
      routes = {
        "/thing": {
          get: this.get(() => ({ ok: true })),
          post: this.post(() => ({ ok: true })),
        },
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);
    expect(Object.keys(routes["/thing"]).sort()).toEqual(["GET", "OPTIONS", "POST"]);
  });

  test("a map of only patch is registered", () => {
    class Root extends ApiRouter {
      routes = {
        "/thing": { patch: this.patch(() => ({ ok: true })) },
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);
    expect(Object.keys(routes["/thing"]).sort()).toEqual(["OPTIONS", "PATCH"]);
  });
});

class ReportController extends Controller {
  export() {
    return {};
  }
}

function sourcesOf(routes: ReturnType<typeof createFlatApiRoutes>) {
  return Object.fromEntries(
    Object.entries(routes).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, handler]) => [
        `${method} ${path}`,
        handler.source,
      ]),
    ),
  );
}

describe("createFlatApiRoutes - proxy routes (#7)", () => {
  const METHODS = ["GET", "POST", "PUT", "DELETE"];

  test("carry the route's own middleware on every method, after the router's", () => {
    class Root extends ApiRouter {
      routes = {
        "/upstream": this.proxy("https://example.com").middleware(["auth", "rate-limit:10"]),
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes, "", ["csrf"]));

    for (const method of METHODS) {
      expect(middlewares[`${method} /upstream`]).toEqual(["csrf", "auth", "rate-limit:10"]);
    }
    expect(middlewares["OPTIONS /upstream"]).toEqual([]);
  });

  test("accept a bare string, as every other route's .middleware() does", () => {
    class Root extends ApiRouter {
      routes = {
        "/upstream": this.proxy("https://example.com").middleware("auth"),
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes));

    expect(middlewares["POST /upstream"]).toEqual(["auth"]);
  });

  test("inherit a nested router's middlewares", () => {
    class Internal extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/upstream": this.proxy("https://example.com"),
      };
    }
    class Root extends ApiRouter {
      routes = { "/internal": Internal };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes(new Root().routes));

    for (const method of METHODS) {
      expect(middlewares[`${method} /internal/upstream`]).toEqual(["auth"]);
    }
  });
});

describe("createFlatApiRoutes - route source", () => {
  test("a resource and a route in a nested, prefixed router report their controller method", () => {
    class OrgRouter extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/products/:productId": this.resource(ProductController),
        "/reports": this.post(ReportController, "export"),
      };
    }

    class Root extends ApiRouter {
      routes = {
        "/:orgId": OrgRouter,
      };
    }

    const sources = sourcesOf(createFlatApiRoutes(new Root().routes));

    expect(sources["GET /:orgId/products"]).toEqual({
      controller: ProductController,
      methodName: "list",
    });
    expect(sources["POST /:orgId/products"]).toEqual({
      controller: ProductController,
      methodName: "store",
    });
    expect(sources["GET /:orgId/products/:productId"]).toEqual({
      controller: ProductController,
      methodName: "show",
    });
    expect(sources["PUT /:orgId/products/:productId"]).toEqual({
      controller: ProductController,
      methodName: "update",
    });
    expect(sources["DELETE /:orgId/products/:productId"]).toEqual({
      controller: ProductController,
      methodName: "delete",
    });
    expect(sources["POST /:orgId/reports"]).toEqual({
      controller: ReportController,
      methodName: "export",
    });
  });

  test("a verb map records each verb's own controller method", () => {
    class Root extends ApiRouter {
      routes = {
        "/reports": {
          get: this.get(ProductController, "list"),
          post: this.post(ReportController, "export"),
        },
      };
    }

    const sources = sourcesOf(createFlatApiRoutes(new Root().routes));

    expect(sources["GET /reports"]).toEqual({
      controller: ProductController,
      methodName: "list",
    });
    expect(sources["POST /reports"]).toEqual({
      controller: ReportController,
      methodName: "export",
    });
  });

  test("a callback route, a proxy route and OPTIONS have no source", () => {
    class Root extends ApiRouter {
      routes = {
        "/health": this.get(() => ({ ok: true })),
        // A `function` has a prototype, so it passes the controller check.
        "/ping": this.get(function () {
          return { ok: true };
        }),
        "/upstream": this.proxy("https://example.com"),
        "/reports": this.post(ReportController, "export"),
      };
    }

    const routes = createFlatApiRoutes(new Root().routes);

    expect("source" in routes["/health"].GET).toBe(false);
    expect("source" in routes["/ping"].GET).toBe(false);
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      expect("source" in routes["/upstream"][method]).toBe(false);
    }
    expect("source" in routes["/reports"].OPTIONS).toBe(false);
  });

  test("a stream route's HEAD has the source of the GET it was cloned from", () => {
    class Root extends ApiRouter {
      routes = {
        "/export": this.stream(ReportController, "export"),
      };
    }

    const sources = sourcesOf(createFlatApiRoutes(new Root().routes));

    const expected = { controller: ReportController, methodName: "export" };
    expect(sources["GET /export"]).toEqual(expected);
    expect(sources["HEAD /export"]).toEqual(expected);
  });

  test("an agent route and a file route report their controller method", () => {
    class ChatController extends AgentController {
      agent = { name: "stub", tools: [], provider: {} } as any;
    }

    class Root extends ApiRouter {
      routes = {
        "/chat": this.agent(ChatController),
        "/download": this.file(ReportController, "export"),
      };
    }

    const sources = sourcesOf(createFlatApiRoutes(new Root().routes));

    expect(sources["POST /chat/stop"]).toEqual({
      controller: ChatController,
      methodName: "stop",
    });
    expect(sources["GET /download"]).toEqual({
      controller: ReportController,
      methodName: "export",
    });
  });
});

describe("createFlatApiRoutes - nested routers inherit middlewares (#1022)", () => {
  test("a nested router's routes run the enclosing router's middlewares first", () => {
    class Pages extends ApiRouter {
      middlewares = ["page-owner"];
      routes = {
        "/:id": this.get(() => ({})),
      };
    }
    class Root extends ApiRouter {
      middlewares = ["cache:private"];
      routes = {
        "/projects": this.get(() => []),
        "/pages": Pages,
      };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["GET /projects"]).toEqual(["cache:private"]);
    expect(middlewares["GET /pages/:id"]).toEqual(["cache:private", "page-owner"]);
  });

  test("inherits through several levels, outermost first, then the route's own", () => {
    class Builds extends ApiRouter {
      middlewares = ["builds"];
      routes = {
        "/:buildId": this.get(() => ({})).middleware(["rate-limit:10,60"]),
        "/": this.post(() => ({})),
      };
    }
    class Page extends ApiRouter {
      middlewares = ["page-owner"];
      routes = { "/builds": Builds, "/": this.get(() => ({})) };
    }
    class Pages extends ApiRouter {
      middlewares = ["auth"];
      routes = { "/:pageId": Page };
    }
    class Root extends ApiRouter {
      middlewares = ["cache:private"];
      routes = { "/pages": Pages };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }, "", ["csrf"]));

    expect(middlewares["GET /pages/:pageId"]).toEqual([
      "csrf",
      "cache:private",
      "auth",
      "page-owner",
    ]);
    expect(middlewares["POST /pages/:pageId/builds"]).toEqual([
      "csrf",
      "cache:private",
      "auth",
      "page-owner",
      "builds",
    ]);
    expect(middlewares["GET /pages/:pageId/builds/:buildId"]).toEqual([
      "csrf",
      "cache:private",
      "auth",
      "page-owner",
      "builds",
      "rate-limit:10,60",
    ]);
  });

  test("a router without middlewares passes its parent's through unchanged", () => {
    class Leaf extends ApiRouter {
      routes = { "/x": this.get(() => ({})) };
    }
    class Middle extends ApiRouter {
      routes = { "/leaf": Leaf };
    }
    class Root extends ApiRouter {
      middlewares = ["auth"];
      routes = { "/middle": Middle };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["GET /middle/leaf/x"]).toEqual(["auth"]);
  });

  test("siblings do not leak middlewares into each other", () => {
    class A extends ApiRouter {
      middlewares = ["a"];
      routes = { "/": this.get(() => ({})) };
    }
    class B extends ApiRouter {
      middlewares = ["b"];
      routes = { "/": this.get(() => ({})) };
    }
    class Root extends ApiRouter {
      middlewares = ["root"];
      routes = { "/a": A, "/b": B };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["GET /a"]).toEqual(["root", "a"]);
    expect(middlewares["GET /b"]).toEqual(["root", "b"]);
  });

  test("a `-alias` on a nested route follows the inherited one, so it can remove it", () => {
    class Account extends ApiRouter {
      middlewares = ["auth"];
      routes = {
        "/welcome": this.get(() => ({})).middleware(["-auth", "-cache"]),
      };
    }
    class Root extends ApiRouter {
      middlewares = ["cache:private"];
      routes = { "/account": Account };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["GET /account/welcome"]).toEqual([
      "cache:private",
      "auth",
      "-auth",
      "-cache",
    ]);
  });

  test("OPTIONS still runs no middleware", () => {
    class Child extends ApiRouter {
      middlewares = ["child"];
      routes = { "/x": this.get(() => ({})) };
    }
    class Root extends ApiRouter {
      middlewares = ["auth"];
      routes = { "/child": Child };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["OPTIONS /child/x"]).toEqual([]);
  });
});

describe("createFlatApiRoutes - (group) segments (#1022)", () => {
  test("a router mounted under a group adds no path segment", () => {
    class Builds extends ApiRouter {
      routes = {
        "/:pageId/builds": this.post(() => ({})),
        "/:pageId/builds/:buildId": this.get(() => ({})),
      };
    }
    class Pages extends ApiRouter {
      routes = {
        "/:pageId": this.get(() => ({})),
        "/(builds)": Builds,
      };
    }

    const routes = createFlatApiRoutes({ "/pages": Pages });

    expect(Object.keys(routes)).toEqual(
      expect.arrayContaining([
        "/pages/:pageId",
        "/pages/:pageId/builds",
        "/pages/:pageId/builds/:buildId",
      ]),
    );
    expect(Object.keys(routes).some((path) => path.includes("("))).toBe(false);
  });

  test("a group's routes keep the group router's middlewares", () => {
    class Builds extends ApiRouter {
      middlewares = ["builds"];
      routes = { "/:pageId/builds": this.post(() => ({})) };
    }
    class Pages extends ApiRouter {
      middlewares = ["page-owner"];
      routes = { "/(builds)": Builds };
    }
    class Root extends ApiRouter {
      middlewares = ["cache:private"];
      routes = { "/pages": Pages };
    }

    const middlewares = middlewaresOf(createFlatApiRoutes({ "/": Root }));

    expect(middlewares["POST /pages/:pageId/builds"]).toEqual([
      "cache:private",
      "page-owner",
      "builds",
    ]);
  });

  test("a group's root route is served at the enclosing path, without a trailing slash", () => {
    class Area extends ApiRouter {
      routes = { "/": this.get(() => ({})) };
    }
    class Pages extends ApiRouter {
      routes = { "/(area)": Area };
    }

    const routes = createFlatApiRoutes({ "/pages": Pages });

    expect(routes["/pages"]?.GET).toBeDefined();
    expect(routes["/pages/"]).toBeUndefined();
  });

  test("a group at the root mounts at /", () => {
    class Area extends ApiRouter {
      routes = { "/": this.get(() => ({})), "/x": this.get(() => ({})) };
    }

    const routes = createFlatApiRoutes({ "/(area)": Area });

    expect(routes["/"]?.GET).toBeDefined();
    expect(routes["/x"]?.GET).toBeDefined();
  });

  test("the view routers' `(group)/` spelling works too", () => {
    class Area extends ApiRouter {
      routes = { "/x": this.get(() => ({})) };
    }
    class Pages extends ApiRouter {
      routes = { "(area)/": Area };
    }

    const routes = createFlatApiRoutes({ "/pages": Pages });

    expect(Object.keys(routes)).toContain("/pages/x");
  });

  test("nested groups are all stripped", () => {
    class Inner extends ApiRouter {
      routes = { "/x": this.get(() => ({})) };
    }
    class Outer extends ApiRouter {
      routes = { "/(inner)": Inner };
    }

    const routes = createFlatApiRoutes({ "/a/(outer)": Outer });

    expect(Object.keys(routes)).toContain("/a/x");
  });

  test("two groups sharing a path each keep their methods", () => {
    class Reads extends ApiRouter {
      routes = { "/:pageId": this.get(() => ({})) };
    }
    class Writes extends ApiRouter {
      routes = { "/:pageId": this.patch(() => ({})) };
    }
    class Pages extends ApiRouter {
      routes = { "/(reads)": Reads, "/(writes)": Writes };
    }

    const routes = createFlatApiRoutes({ "/pages": Pages });

    expect(routes["/pages/:pageId"]?.GET).toBeDefined();
    expect(routes["/pages/:pageId"]?.PATCH).toBeDefined();
  });

  test("a URLPattern regex in parentheses is not a group", () => {
    class Root extends ApiRouter {
      routes = { "/items/:id(\\d+)": this.get(() => ({})) };
    }

    const routes = createFlatApiRoutes(new Root().routes);

    expect(Object.keys(routes)).toContain("/items/:id(\\d+)");
  });
});

describe("removeApiGroupSegments", () => {
  test.each([
    ["/pages/(builds)/:pageId", "/pages/:pageId"],
    ["/pages/(builds)", "/pages"],
    ["/(area)", "/"],
    ["(auth)/x", "/x"],
    ["/pages(auth)/x", "/pages/x"],
    ["/a/(b)/(c-d)/e", "/a/e"],
    ["/items/:id(\\d+)", "/items/:id(\\d+)"],
    ["/items/:id(foo)", "/items/:id(foo)"],
    ["/items/(\\d+)", "/items/(\\d+)"],
    ["/plain/path/", "/plain/path/"],
  ])("%s -> %s", (input, expected) => {
    expect(removeApiGroupSegments(input)).toBe(expected);
  });
});
