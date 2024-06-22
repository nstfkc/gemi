import { describe, test, expect } from "vitest";

import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { ViewRouter } from "../http/ViewRouter";
import { Controller } from "../http/Controller";

class TestController extends Controller {
  test() {
    return { data: {} };
  }
}

class FlatRouter extends ViewRouter {
  middlewares = ["auth"];

  routes = {
    "/": this.view("Home", [TestController, "test"]).middleware([
      "homeMiddleware",
    ]),
    "/about": this.view("About", [TestController, "test"]),
    "/pricing": this.view("Pricing", [TestController, "test"]),
  };
}

describe.only("createFlatViewRoutes()", () => {
  test("FlatRouter", () => {
    const result = createFlatViewRoutes({ "/": FlatRouter });
    expect(Object.keys(result)).toEqual(["/", "/about", "/pricing"]);

    expect(result["/"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth", "homeMiddleware"],
    });

    expect(result["/about"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/pricing"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });
  });
});
