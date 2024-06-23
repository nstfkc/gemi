import { describe, test, expect } from "vitest";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";

import { createRoot } from "../client/createRoot";
import { createElement } from "react";

class RootApiRouter extends ApiRouter {
  routes = {
    "/test": this.get(() => {
      return { data: { message: "hi" } };
    }),
  };
}
class RootViewRouter extends ViewRouter {}

const Root = () => createElement("div");

const app = new App({
  root: createRoot(Root),
  apiRouter: RootApiRouter,
  viewRouter: RootViewRouter,
});

describe("App", () => {
  test("should be defined", async () => {
    const request = new Request("http://gemi.dev/api/test", {
      method: "GET",
    });
    const res = await app.handleRequest(request);
    expect(res).toEqual({});
  });
});
