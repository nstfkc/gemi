import { expect, describe, test } from "vitest";

import { Controller } from "./Controller";
import { Router } from "./Router";

import { flattenRoutes } from "./flattenRoutes";

class TestController extends Controller {
  test() {
    return {};
  }
}

describe("flattenRoutes()", () => {
  test("simple", () => {
    const routes = {
      "/": Router.view([TestController, "test", "Foo"]),
    };

    const result = flattenRoutes(routes);
    expect(result).toEqual({});
  });
});
