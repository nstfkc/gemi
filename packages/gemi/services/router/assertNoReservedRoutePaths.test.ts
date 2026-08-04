import { describe, expect, test } from "vitest";
import { assertNoReservedRoutePaths } from "./ViewRouteDispatcher";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { ViewRouter } from "../../http/ViewRouter";

describe("assertNoReservedRoutePaths()", () => {
  test("allows ordinary routes", () => {
    expect(() =>
      assertNoReservedRoutePaths(["/", "/about", "/files/logo.svg", "/assetsomething"]),
    ).not.toThrow();
  });

  test("rejects the reserved prefix itself and anything under it", () => {
    expect(() => assertNoReservedRoutePaths(["/assets"])).toThrow(/reserved "\/assets" prefix/);
    expect(() => assertNoReservedRoutePaths(["/assets/logo.svg"])).toThrow(/"\/assets\/logo\.svg"/);
  });

  test("reports every offending path at once", () => {
    expect(() => assertNoReservedRoutePaths(["/", "/assets/a.png", "/assets/b.css"])).toThrow(
      /"\/assets\/a\.png", "\/assets\/b\.css"/,
    );
  });

  test("catches a route nested under a mounted router", () => {
    class Nested extends ViewRouter {
      routes = {
        "/logo.svg": this.file(() => new File(["x"], "logo.svg")),
      };
    }

    class Root extends ViewRouter {
      routes = {
        "/assets": Nested,
      };
    }

    const paths = Object.keys(createFlatViewRoutes({ "/": Root }));
    expect(paths).toContain("/assets/logo.svg");
    expect(() => assertNoReservedRoutePaths(paths)).toThrow(/reserved/);
  });
});
