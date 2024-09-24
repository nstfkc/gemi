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
  };
}

describe.only("createFlatViewRoutes()", () => {
  test("FlatRouter", () => {
    const result = createFlatViewRoutes({ "/": FlatRouter });
    expect(Object.keys(result)).toEqual([
      "/",
      "/about",
      "/pricing",
      "/foo",
      "/foo/bar",
      "/foo/bar/baz",
      "/foo/bar/cux",
      "/app",
      "/app/settings",
    ]);

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

    expect(result["/foo"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/foo/bar"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/foo/bar/baz"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/foo/bar/cux"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/app"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });

    expect(result["/app/settings"]).toEqual({
      exec: [expect.any(Function)],
      middleware: ["auth"],
    });
  });
});
