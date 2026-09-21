import { describe, test, expect } from "vitest";

import { createFlatApiRoutes } from "./createFlatApiRoutes";
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
