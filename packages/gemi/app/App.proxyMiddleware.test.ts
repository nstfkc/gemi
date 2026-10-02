import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { RequestBreakerError } from "../http/Error";
import { Middleware } from "../http/Middleware";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";

process.env.SECRET ??= "test-secret";

/**
 * A `proxy()` route behind middleware, end to end through `App.fetch` (#7):
 * a refusing middleware ends the request before anything is forwarded, and a
 * passing one lets it through.
 */

const ran: string[] = [];

class Refused extends RequestBreakerError {
  constructor() {
    super("no key");
    this.payload = {
      api: { status: 401, data: { error: "no key" } },
      view: { status: 401, error: { message: "no key" } },
    };
  }
}

class RequireKey extends Middleware {
  run() {
    ran.push("require-key");
    if (this.req.headers.get("x-key") !== "k") {
      throw new Refused();
    }
  }
}

class Tag extends Middleware {
  run() {
    ran.push("tag");
  }
}

class Guarded extends ApiRouter {
  middlewares = ["tag"];
  routes = {
    "/upstream": this.proxy("http://upstream.internal/echo"),
  };
}

class Api extends ApiRouter {
  routes = {
    "/upstream": this.proxy("http://upstream.internal/echo").middleware([
      "require-key",
    ]),
    "/guarded": Guarded,
  };
}

class Views extends ViewRouter {
  routes = {};
}

class TestKernel extends Kernel {
  config = {
    middleware: { aliases: { "require-key": RequireKey, tag: Tag } },
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: Views },
    },
  };
}

const app = new App({ kernel: TestKernel });

let upstream: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ran.length = 0;
  upstream = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response("from upstream", { status: 200 }),
    );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a `proxy()` route with middleware", () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    test(`${method}: a refusing middleware ends the request and nothing is forwarded`, async () => {
      const res = (await app.fetch(
        new Request("http://gemi.dev/api/upstream", { method }),
      )) as Response;

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "no key" });
      expect(ran).toEqual(["require-key"]);
      expect(upstream).not.toHaveBeenCalled();
    });
  }

  test("a passing middleware lets the request through to the upstream", async () => {
    const res = (await app.fetch(
      new Request("http://gemi.dev/api/upstream", {
        method: "POST",
        headers: { "x-key": "k" },
      }),
    )) as Response;

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from upstream");
    expect(ran).toEqual(["require-key"]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe("http://upstream.internal/echo");
  });

  test("the enclosing router's middlewares run before forwarding", async () => {
    const res = (await app.fetch(
      new Request("http://gemi.dev/api/guarded/upstream"),
    )) as Response;

    expect(res.status).toBe(200);
    expect(ran).toEqual(["tag"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
