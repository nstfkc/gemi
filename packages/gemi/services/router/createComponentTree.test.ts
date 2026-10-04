import { describe, test, expect } from "vitest";
import { createComponentTree } from "./createComponentTree";
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

// #788: the kyte shape — a legacy path that redirects through the same view as
// its replacement, which takes params.
class SharedViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/pages/:pageId/preview": this.view("SharedPreview", async () => {
      throw new Error("redirects");
    }),
    "/previews/:token": this.view("SharedPreview"),
  };
}

class SharedLayoutRouter extends ViewRouter {
  routes = {
    "/a": this.layout("Layout", {
      "/": this.view("A"),
      "/shared": this.view("Shared"),
    }),
    "/b": this.layout("Layout", {
      "/": this.view("B"),
      "/shared": this.view("Shared"),
    }),
  };
}

class GroupA extends ViewRouter {
  routes = { "/x": this.view("Shared") };
}

class GroupB extends ViewRouter {
  routes = { "/y": this.view("Shared"), "/z": this.view("Z") };
}

describe("createComponentTree()", () => {
  test("a view used by two routes appears once (#788)", () => {
    expect(createComponentTree({ "/": SharedViewRouter })).toEqual([
      ["Home", []],
      ["SharedPreview", []],
    ]);
  });

  test("a layout used under two prefixes appears once, with merged children", () => {
    expect(createComponentTree({ "/": SharedLayoutRouter })).toEqual([
      [
        "Layout",
        [
          ["A", []],
          ["Shared", []],
          ["B", []],
        ],
      ],
    ]);
  });

  test("a view shared across group routers appears once", () => {
    expect(createComponentTree({ "/a": GroupA, "/b": GroupB })).toEqual([
      ["Shared", []],
      ["Z", []],
    ]);
  });

  test("FlatRouter", () => {
    const result = createComponentTree({ "/": FlatRouter });
    expect(result).toEqual([
      ["Home", []],
      ["About", []],
      ["Pricing", []],
    ]);
  });

  test("NestedRouter", () => {
    const result = createComponentTree({ "/": NestedRouter });
    expect(result).toEqual([
      [
        "Layout",
        [
          ["Home", []],
          ["About", []],
          ["Pricing", []],
        ],
      ],
    ]);
  });

  test("DeeplyNestedRouter", () => {
    const result = createComponentTree({ "/": DeeplyNestedRouter });
    expect(result).toEqual([
      [
        "Layout",
        [
          ["Home", []],
          ["About", []],
          ["Pricing", []],
          [
            "ProductsLayout",
            [
              ["Products", []],
              ["Product", []],
              ["ProductProviders", []],
            ],
          ],
          [
            "Foo",
            [
              [
                "Bar",
                [
                  ["Baz", []],
                  ["Cux", []],
                ],
              ],
            ],
          ],
          [
            "PrivateLayout",
            [
              ["Dashboard", []],
              ["Settings", []],
            ],
          ],
        ],
      ],
    ]);
  });
});
