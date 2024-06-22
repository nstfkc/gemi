import { describe, test, expect } from "vitest";
import { createRouteManifest } from "./createRouteManifest";
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

  test("DeeplyNestedRouter", () => {
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
    });
  });
});
