import { describe, test, expect } from "vitest";

import { createFlatViewRoutes, type FlatViewRoutes } from "./createFlatViewRoutes";
import { Controller } from "../../http/Controller";
import { ViewRouter } from "../../http/ViewRouter";

class TestController extends Controller {
  test() {
    return { data: {} };
  }
}

class FlatRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.view("Home", [TestController, "test"]).middleware(["homeMiddleware"]),
    "/about": this.view("About", [TestController, "test"]),
    "/pricing": this.view("Pricing", [TestController, "test"]),
    "/app": this.layout("PrivateLayout", [TestController, "test"], {
      "/": this.view("Dashboard", [TestController, "test"]),
      "/settings": this.view("Settings", [TestController, "test"]),
    }),
  };
}

class ProductsRouter extends ViewRouter {
  middlewares = ["products"];

  routes = {
    "/": this.layout("ProductsLayout", [TestController, "test"], {
      "/": this.view("Products"),
      "/:productId": this.view("Product"),
      "/:productId/providers": this.view("ProductProviders"),
    }),
  };
}

class DeeplyNestedRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", [TestController, "test"], {
      "/": this.view("Home", [TestController, "test"]),
      "/products": ProductsRouter,
      "/foo": this.layout("Foo", [TestController, "test"], {
        "/bar": this.layout("Bar", [TestController, "test"], {
          "/baz": this.view("Baz", [TestController, "test"]),
          "/cux": this.view("Cux", [TestController, "test"]),
        }),
      }),
    }),
  };
}

class GroupedRouter extends ViewRouter {
  routes = {
    "/(marketing)": this.layout("MarketingLayout", [TestController, "test"], {
      "/": this.view("Home", [TestController, "test"]),
      "/pricing": this.view("Pricing", [TestController, "test"]),
    }),
    "/app/(private)": this.layout("PrivateLayout", [TestController, "test"], {
      "/:orgId/chat": this.view("Chat", [TestController, "test"]),
    }),
  };
}

/** `segments[i]` describes what `exec[i]` renders, so they must stay aligned. */
function expectSegmentsMatchExec(routes: FlatViewRoutes) {
  for (const [routePath, { exec, segments }] of Object.entries(routes)) {
    expect(segments).toHaveLength(exec.length);
    // The leaf segment is the route itself. (A route key can keep a trailing
    // slash when a group is its last part; segment paths never do.)
    expect(segments.at(-1).path).toBe(routePath.replace(/(.)\/$/, "$1"));
  }
}

describe("createFlatViewRoutes()", () => {
  test("FlatRouter", () => {
    const result = createFlatViewRoutes({ "/": FlatRouter });
    expect(Object.keys(result)).toEqual(["/", "/about", "/pricing", "/app", "/app/settings"]);

    expect(result["/"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth", "homeMiddleware"],
      viewPath: "Home",
      segments: [{ path: "/", viewPath: "Home" }],
    });

    expect(result["/about"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
      viewPath: "About",
      segments: [{ path: "/about", viewPath: "About" }],
    });

    expect(result["/app"]).toEqual({
      exec: [expect.any(Function), expect.any(Function)],
      middleware: ["auth"],
      viewPath: "PrivateLayout",
      segments: [
        { path: "/app", viewPath: "PrivateLayout" },
        { path: "/app", viewPath: "Dashboard" },
      ],
    });

    expect(result["/app/settings"]).toEqual({
      exec: [expect.any(Function), expect.any(Function)],
      middleware: ["auth"],
      viewPath: "PrivateLayout",
      segments: [
        { path: "/app", viewPath: "PrivateLayout" },
        { path: "/app/settings", viewPath: "Settings" },
      ],
    });

    expectSegmentsMatchExec(result);
  });

  test("DeeplyNestedRouter", () => {
    const result = createFlatViewRoutes({ "/": DeeplyNestedRouter });

    expect(Object.keys(result).sort()).toEqual([
      "/",
      "/foo/bar/baz",
      "/foo/bar/cux",
      "/products",
      "/products/:productId",
      "/products/:productId/providers",
    ]);

    expect(result["/foo/bar/baz"].segments).toEqual([
      { path: "/", viewPath: "Layout" },
      { path: "/foo", viewPath: "Foo" },
      { path: "/foo/bar", viewPath: "Bar" },
      { path: "/foo/bar/baz", viewPath: "Baz" },
    ]);

    expect(result["/foo/bar/cux"].segments).toEqual([
      { path: "/", viewPath: "Layout" },
      { path: "/foo", viewPath: "Foo" },
      { path: "/foo/bar", viewPath: "Bar" },
      { path: "/foo/bar/cux", viewPath: "Cux" },
    ]);

    // A nested `ViewRouter` is a mount point, not a segment — it contributes a
    // path prefix and its middleware, but no handler and no view.
    expect(result["/products/:productId"].segments).toEqual([
      { path: "/", viewPath: "Layout" },
      { path: "/products", viewPath: "ProductsLayout" },
      { path: "/products/:productId", viewPath: "Product" },
    ]);
    expect(result["/products/:productId"].middleware).toEqual(["products"]);

    // The layout's own index route: the layout and the view sit on the same path.
    expect(result["/products"].segments).toEqual([
      { path: "/", viewPath: "Layout" },
      { path: "/products", viewPath: "ProductsLayout" },
      { path: "/products", viewPath: "Products" },
    ]);

    expectSegmentsMatchExec(result);
  });

  test("marks the segment of a layout that opted out of being skipped", () => {
    class OptedOutRouter extends ViewRouter {
      routes = {
        "/live": this.layout("LiveLayout", [TestController, "test"], {
          "/chat": this.view("LiveChat"),
        }).alwaysRun(),
        "/app": this.layout("AppLayout", [TestController, "test"], {
          "/chat": this.view("Chat"),
        }),
      };
    }

    const result = createFlatViewRoutes({ "/": OptedOutRouter });

    expect(result["/live/chat"].segments).toEqual([
      { path: "/live", viewPath: "LiveLayout", alwaysRun: true },
      { path: "/live/chat", viewPath: "LiveChat" },
    ]);

    expect(result["/app/chat"].segments).toEqual([
      { path: "/app", viewPath: "AppLayout" },
      { path: "/app/chat", viewPath: "Chat" },
    ]);
  });

  test("group prefixes are stripped from segment paths", () => {
    const result = createFlatViewRoutes({ "/": GroupedRouter });

    expect(Object.keys(result).sort()).toEqual(["/", "/app/:orgId/chat", "/pricing"]);

    expect(result["/pricing"].segments).toEqual([
      { path: "/", viewPath: "MarketingLayout" },
      { path: "/pricing", viewPath: "Pricing" },
    ]);

    expect(result["/app/:orgId/chat"].segments).toEqual([
      { path: "/app", viewPath: "PrivateLayout" },
      { path: "/app/:orgId/chat", viewPath: "Chat" },
    ]);

    expectSegmentsMatchExec(result);
  });
});
