import { describe, test, expect } from "vitest";
import { createRouteManifest } from "./createRouteManifest";
import { ViewRouter } from "../../http/ViewRouter";
import { Controller } from "../../http/Controller";

class TestController extends Controller {
  test() {
    return { data: {} };
  }
}

class FlatRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", [TestController, "test"]),
    "/about": this.view("About", [TestController, "test"]),
    "/pricing": this.view("Pricing", [TestController, "test"]),
  };
}

class NestedRouter extends ViewRouter {
  routes = {
    "/": this.layout("Layout", [TestController, "test"], {
      "/": this.view("Home", [TestController, "test"]),
      "/about": this.view("About", [TestController, "test"]),
      "/pricing": this.view("Pricing", [TestController, "test"]),
    }),
  };
}

class ProductsRouter extends ViewRouter {
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
      "/about": this.view("About", [TestController, "test"]),
      "/pricing": this.view("Pricing", [TestController, "test"]),
      "/products": ProductsRouter,
      "/foo": this.layout("Foo", [TestController, "test"], {
        "/bar": this.layout("Bar", [TestController, "test"], {
          "/baz": this.view("Baz", [TestController, "test"]),
          "/cux": this.view("Cux", [TestController, "test"]),
        }),
      }),
      "/app": this.layout("PrivateLayout", [TestController, "test"], {
        "/": this.view("Dashboard", [TestController, "test"]),
        "/settings": this.view("Settings", [TestController, "test"]),
      }),
    }),
  };
}

describe("createRouteManifest()", () => {
  test("FlatRouter", () => {
    const result = createRouteManifest({ "/": FlatRouter });
    expect(result).toEqual({
      "/": ["Home"],
      "/about": ["About"],
      "/pricing": ["Pricing"],
    });
  });

  test("NestedRouter", () => {
    const result = createRouteManifest({ "/": NestedRouter });

    expect(result).toEqual({
      "/": ["Layout", "Home"],
      "/about": ["Layout", "About"],
      "/pricing": ["Layout", "Pricing"],
    });
  });

  /**
   * `/foo` and `/foo/bar` are **not** in the manifest, and that is the correct
   * answer rather than a missing one.
   *
   * Both are layouts with no index route — `/foo` holds only `/bar`, and `/bar`
   * holds only `/baz` and `/cux` — so neither path resolves to a page, and an
   * entry for one would render layouts around a blank content area.
   *
   * This assertion used to list them, and the file was excluded from CI rather
   * than reconciled (#163). `createFlatViewRoutes` settles it: its own test
   * passes on this exact fixture, and there `/foo` and `/foo/bar` appear only as
   * *segments* of `/foo/bar/baz`, never as matchable routes. A manifest entry
   * for a path the router will not match is a route to nowhere.
   */
  test("DeeplyNestedRouter omits layouts that have no index route", () => {
    const result = createRouteManifest({ "/": DeeplyNestedRouter });

    expect(result).toEqual({
      "/": ["Layout", "Home"],
      "/about": ["Layout", "About"],
      "/pricing": ["Layout", "Pricing"],
      "/products": ["Layout", "ProductsLayout", "Products"],
      "/products/:productId": ["Layout", "ProductsLayout", "Product"],
      "/products/:productId/providers": [
        "Layout",
        "ProductsLayout",
        "ProductProviders",
      ],
      "/foo/bar/baz": ["Layout", "Foo", "Bar", "Baz"],
      "/foo/bar/cux": ["Layout", "Foo", "Bar", "Cux"],
      "/app": ["Layout", "PrivateLayout", "Dashboard"],
      "/app/settings": ["Layout", "PrivateLayout", "Settings"],
    });
  });

  /**
   * The pair the assertion above turns on, stated on its own so a future change
   * that reintroduces them fails with a sentence rather than a large diff.
   */
  test("a layout with no index route is absent, while its leaves are present", () => {
    const result = createRouteManifest({ "/": DeeplyNestedRouter });

    expect(result).not.toHaveProperty("/foo");
    expect(result).not.toHaveProperty("/foo/bar");
    expect(result["/foo/bar/baz"]).toEqual(["Layout", "Foo", "Bar", "Baz"]);
  });
});
