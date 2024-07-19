import { describe, test, expect } from "vitest";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";

import { createRoot } from "../client/createRoot";
import { createElement } from "react";
import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { Middleware, RequestBreakerError } from "../http";
import { Kernel } from "../kernel";

class ValidationRequest extends HttpRequest<{ name: string; age: number }, {}> {
  schema = {
    name: {
      required: "Name is required",
      string: "Name must be a string",
    },
    age: {
      required: "Age is required",
      number: "Age must be a number",
    },
  };
}

class TestController extends Controller {
  requests = {
    validate: ValidationRequest,
  };

  test() {
    return { message: "test" };
  }
  async foo(req: HttpRequest) {
    const body = await req.input();

    return body.toJSON();
  }

  async validate(req: ValidationRequest) {
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
    "/bar": this.get(TestController, "test").middleware(["auth"]),
    "/baz": this.post(TestController, "validate"),
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

export class AuthenticationError extends RequestBreakerError {
  constructor() {
    super("Authentication error");
    this.name = "AuthenticationError";
  }

  payload = {
    api: {
      status: 401,
      data: { error: "Authentication error" },
    },
    view: {
      status: 302,
      headers: {
        "Cache-Control":
          "private, no-cache, no-store, max-age=0, must-revalidate",
        Location: "/auth/sign-in",
      },
    },
  };
}

class AuthMiddleware extends Middleware {
  async run(req: HttpRequest) {
    throw new AuthenticationError();

    return {};
  }
}

const app = new App({
  root: createRoot(() => createElement("div")),
  apiRouter: RootApiRouter,
  viewRouter: RootViewRouter,
  kernel: Kernel,
  middlewareAliases: {
    auth: AuthMiddleware,
  },
});

describe("App fetch()", () => {
  test("view", async () => {
    const res1 = await app.fetch(
      new Request("http://gemi.dev", {
        method: "GET",
      }),
    );

    expect(await res1.text()).toMatchSnapshot();
  });

  test("api", async () => {
    const res = await app.fetch(
      new Request("http://gemi.dev/api/test", {
        method: "GET",
      }),
    );

    expect(await res.json()).toEqual({ message: "hi" });
  });

  test("view controller handler", async () => {
    const request = new Request("http://gemi.dev/about?json=true", {
      method: "GET",
    });
    const res = await app.fetch(request);
    expect(await res.json()).toEqual({
      data: { "/about": { About: { message: "test" } } },
      head: {},
    });
  });

  test("api callback handler", async () => {
    const request = new Request("http://gemi.dev/api/test", {
      method: "GET",
    });
    const res = await app.fetch(request);

    expect(await res.json()).toEqual({ message: "hi" });
  });

  test("api controller handler", async () => {
    const request = new Request("http://gemi.dev/api/foo", {
      method: "POST",
      body: JSON.stringify({ data: 1 }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const res = await app.fetch(request);
    expect(await res.json()).toEqual({ data: 1 });
  });

  test("api handler with middleware", async () => {
    const request = new Request("http://gemi.dev/api/bar", {
      method: "GET",
      body: JSON.stringify({ data: 1 }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const res = await app.fetch(request);

    expect(await res.json()).toEqual({ error: "Authentication error" });
    expect(res.status).toBe(401);
  });

  test("api handler with validation", async () => {
    const request = new Request("http://gemi.dev/api/baz", {
      method: "POST",
      body: JSON.stringify({ age: "12" }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const res = await app.fetch(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        kind: "validation_error",
        messages: {
          age: ["Age must be a number"],
          name: ["Name is required"],
        },
      },
    });
  });

  test("404 api handler", async () => {
    const request = new Request("http://gemi.dev/api/404", {
      method: "GET",
    });
    const res = await app.fetch(request);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: "Not found" } });
  });

  test("404 view handler", async () => {
    const request = new Request("http://gemi.dev/not-found", {
      method: "GET",
    });
    const res = await app.fetch(request);
    expect(res.status).toBe(404);
  });
});
