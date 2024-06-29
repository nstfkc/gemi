import { describe, test, expect } from "vitest";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";

import { createRoot } from "../client/createRoot";
import { createElement } from "react";
import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";

class TestController extends Controller {
  test() {
    return { message: "test" };
  }
  async foo(req: HttpRequest) {
    const body = await req.input();

    return body.toJSON();
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/test": this.get(() => {
      return { message: "hi" };
    }),
    "/foo": this.post(TestController, "foo"),
  };
}
class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => {
      return { message: "Home" };
    }),
    "/about": this.view("About", [TestController, "test"]),
  };
}

const Root = () => createElement("div");

const app = new App({
  root: createRoot(Root),
  apiRouter: RootApiRouter,
  viewRouter: RootViewRouter,
});

describe("App", () => {
  test("view data callback handler", async () => {
    const request = new Request("http://gemi.dev?json=true", {
      method: "GET",
    });
    const res = await app.handleRequest(request);
    expect(res.data).toEqual({ "/": { Home: { message: "Home" } } });
  });

  test("view controller handler", async () => {
    const request = new Request("http://gemi.dev/about?json=true", {
      method: "GET",
    });
    const res = await app.handleRequest(request);
    expect(res.data).toEqual({ "/about": { About: { message: "test" } } });
  });

  test("api callback handler", async () => {
    const request = new Request("http://gemi.dev/api/test", {
      method: "GET",
    });
    const res = await app.handleRequest(request);
    expect(res.data).toEqual({ message: "hi" });
  });

  test("api controller handler", async () => {
    const request = new Request("http://gemi.dev/api/foo", {
      method: "POST",
      body: JSON.stringify({ data: 1 }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const res = await app.handleRequest(request);
    expect(res.data).toEqual({ data: 1 });
  });
});
