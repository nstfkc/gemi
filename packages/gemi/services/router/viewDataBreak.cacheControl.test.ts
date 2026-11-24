import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { createRoot } from "../../client/createRoot";
import { Redirect } from "../../facades/Redirect";
import { RequestBreakerError } from "../../http/Error";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A redirect or a refusal answered to a `.json` navigation depends on who
 * asks, and a redirect answers it with a 200. Without a Cache-Control a CDN
 * that caches by path served one user's directive to everyone after (#1388).
 */

process.env.SECRET ??= "view-data-break-cache-control-test-secret";

const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

class ToSignIn extends Middleware {
  run() {
    Redirect.to("/sign-in" as never);
  }
}

/** A 403 or 404 breaker renders the `404` view instead (#726); a 409 keeps its own answer. */
class NotAMember extends RequestBreakerError {
  constructor() {
    super("not a member");
    this.payload = {
      api: { status: 409, data: { error: "not a member" } },
      view: { status: 409, error: { message: "not a member" } },
    };
  }
}

class MembersOnly extends Middleware {
  run() {
    throw new NotAMember();
  }
}

class Forbidden extends RequestBreakerError {
  constructor() {
    super("forbidden");
    this.payload = {
      api: { status: 403, data: { error: "forbidden" } },
      view: { status: 403, error: { message: "forbidden" } },
    };
  }
}

class Forbid extends Middleware {
  run() {
    throw new Forbidden();
  }
}

class Cacheable extends RequestBreakerError {
  constructor() {
    super("cacheable");
    this.payload = {
      api: {
        status: 200,
        data: {},
        directive: { kind: "Redirect", path: "/elsewhere" },
        headers: { "Cache-Control": "public, max-age=60" },
      },
      view: { status: 307, headers: { Location: "/elsewhere" } },
    };
  }
}

class MovedForEveryone extends Middleware {
  run() {
    throw new Cacheable();
  }
}

/** Redirects only the paths under `/gated`, so the rest reach the router. */
class GlobalGate extends Middleware {
  run() {
    if (new URL(this.req.rawRequest.url).pathname.startsWith("/gated")) {
      Redirect.to("/sign-in" as never);
    }
  }
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/dashboard": this.view("Dashboard", () => ({ Dashboard: {} })).middleware(["to-sign-in"]),
    "/team": this.view("Team", () => ({ Team: {} })).middleware(["members-only"]),
    "/moved": this.view("Moved", () => ({ Moved: {} })).middleware(["moved"]),
    "/forbidden": this.view("Forbidden", () => ({ Forbidden: {} })).middleware(["forbid"]),
    "/in-handler": this.view("InHandler", () => {
      Redirect.to("/sign-in" as never);
      return { InHandler: {} };
    }),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: {
        "to-sign-in": ToSignIn,
        "members-only": MembersOnly,
        moved: MovedForEveryone,
        gate: GlobalGate,
        forbid: Forbid,
      },
      global: ["gate"],
    },
    route: {
      api: { rootRouter: class extends ApiRouter {} },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

async function request(path: string) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

describe("a break answered to a .json navigation", () => {
  test("a Redirect.to from a view middleware is never cached", async () => {
    const res = await request("/dashboard.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {},
      directive: { kind: "Redirect", path: "/sign-in" },
    });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  test("a Redirect.to from a view handler is never cached", async () => {
    const res = await request("/in-handler.json");
    expect(await res.json()).toMatchObject({ directive: { kind: "Redirect", path: "/sign-in" } });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  test("a Redirect.to from a global middleware is never cached", async () => {
    const res = await request("/gated/reports.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ directive: { kind: "Redirect", path: "/sign-in" } });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  test("a refusal is never cached", async () => {
    const res = await request("/team.json");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ data: { error: "not a member" } });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });

  test("a 403 refusal, answered as the 404 view (#726), is not cached either", async () => {
    const res = await request("/forbidden.json");
    expect([res.status, res.headers.get("Cache-Control")]).toEqual([200, "no-store"]);
  });

  test("keeps a Cache-Control the breaker sets itself", async () => {
    const res = await request("/moved.json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});
