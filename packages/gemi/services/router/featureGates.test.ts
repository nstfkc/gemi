import { describe, expect, test } from "vitest";
import { ViewRouter } from "../../http/ViewRouter";
import { createFlatViewRoutes } from "./createFlatViewRoutes";

describe("feature gates on view routes", () => {
  test("a route carries the flag it declares", () => {
    class Router extends ViewRouter {
      routes = {
        "/": this.view("Home"),
        "/beta": this.view("Beta").feature("beta-area" as never),
      };
    }

    const flat = createFlatViewRoutes({ "/": Router });

    expect(flat["/"].features).toEqual([]);
    expect(flat["/beta"].features).toEqual(["beta-area"]);
  });

  test(".feature() is chainable with .middleware()", () => {
    class Router extends ViewRouter {
      routes = {
        "/beta": this.view("Beta").middleware("auth").feature("beta-area" as never),
      };
    }

    const flat = createFlatViewRoutes({ "/": Router });

    expect(flat["/beta"].features).toEqual(["beta-area"]);
    expect(flat["/beta"].middleware).toEqual(["auth"]);
  });

  test("gates accumulate from a router down to its routes", () => {
    class Inner extends ViewRouter {
      featureGates = ["section"];
      routes = {
        "/page": this.view("Page").feature("page" as never),
      };
    }
    class Root extends ViewRouter {
      routes = { "/app": Inner };
    }

    const flat = createFlatViewRoutes({ "/": Root });

    // The intersection is the only reading that composes: a route inside a
    // gated section must not be more reachable than the section.
    expect(flat["/app/page"].features).toEqual(["section", "page"]);
  });

  test("gates accumulate through a layout", () => {
    class Router extends ViewRouter {
      routes = {
        "/app": this.layout("AppLayout", {
          "/settings": this.view("Settings").feature("settings" as never),
        }).feature("app" as never),
      };
    }

    const flat = createFlatViewRoutes({ "/": Router });

    expect(flat["/app/settings"].features).toEqual(["app", "settings"]);
  });

  test("multiple gates on one route are all recorded", () => {
    class Router extends ViewRouter {
      routes = {
        "/x": this.view("X").feature("a" as never).feature("b" as never),
      };
    }

    const flat = createFlatViewRoutes({ "/": Router });

    expect(flat["/x"].features).toEqual(["a", "b"]);
  });

  test("an ungated tree records empty arrays, never undefined", () => {
    // The dispatcher checks `features.length > 0` before evaluating anything,
    // so an undefined here would throw on every request to an ungated route.
    class Inner extends ViewRouter {
      routes = { "/deep": this.view("Deep") };
    }
    class Router extends ViewRouter {
      routes = {
        "/": this.view("Home"),
        "/app": this.layout("AppLayout", { "/x": this.view("X") }),
        "/nested": Inner,
      };
    }

    const flat = createFlatViewRoutes({ "/": Router });

    for (const route of Object.values(flat)) {
      expect(Array.isArray(route.features)).toBe(true);
    }
  });
});
