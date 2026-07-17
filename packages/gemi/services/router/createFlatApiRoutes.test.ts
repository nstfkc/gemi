import { describe, test, expect } from "vitest";

import { createFlatApiRoutes } from "./createFlatApiRoutes";
import { ApiRouter } from "../../http/ApiRouter";
import { ResourceController } from "../../http/Controller";

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
