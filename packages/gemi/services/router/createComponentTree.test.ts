import { describe, test, expect } from "vitest";
import { createComponentTree } from "./createComponentTree";
import { ViewRouter } from "../http/ViewRouter";
import { Controller } from "../http/Controller";

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
    "/": this.view("Layout", [TestController, "test"], {
      "/": this.view("Home", [TestController, "test"]),
      "/about": this.view("About", [TestController, "test"]),
      "/pricing": this.view("Pricing", [TestController, "test"]),
    }),
  };
}

class ProductsRouter extends ViewRouter {
  routes = {
    "/": this.view("ProductsLayout", [TestController, "test"], {
      "/": this.view("Products"),
      "/:productId": this.view("Product"),
      "/:productId/providers": this.view("ProductProviders"),
    }),
  };
}

class DeeplyNestedRouter extends ViewRouter {
  routes = {
    "/": this.view("Layout", [TestController, "test"], {
      "/": this.view("Home", [TestController, "test"]),
      "/about": this.view("About", [TestController, "test"]),
      "/pricing": this.view("Pricing", [TestController, "test"]),
      "/products": ProductsRouter,
      "/foo": this.view("Foo", [TestController, "test"], {
        "/bar": this.view("Bar", [TestController, "test"], {
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

describe("createComponentTree()", () => {
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
