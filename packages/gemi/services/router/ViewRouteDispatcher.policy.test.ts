import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { QueryError } from "../../client/QueryError";
import { Query } from "../../facades/Prefetch";
import { ApiRouter } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { isSystemScope } from "../../orm/context";
import { PolicyDeniedError } from "../../orm/errors";
import { applyPolicies, currentUser, policyContext } from "../../orm/policy";
import { ServiceProvider } from "../../support/ServiceProvider";

/**
 * A policy denial in a view's loader or middleware, through a whole `App`: the
 * counterpart of the api side's "a policy denial" tests in
 * `ApiRouteDispatcher.dispatchAs.test.ts`.
 */

process.env.SECRET ??= "view-policy-test-secret";

const SESSIONS: Record<string, { id: number; name: string }> = {
  "tok-alice": { id: 1, name: "alice" },
  "tok-bob": { id: 2, name: "bob" },
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const user = SESSIONS[args.token];
    return user ? ({ token: args.token, user } as any) : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

/** Bob may not read orders; everybody else may. */
const ordersPolicy = {
  before: (ctx: any) => ctx.user?.id !== 2,
};

function readOrders() {
  applyPolicies(
    [ordersPolicy],
    policyContext("Order", "findMany", currentUser(), isSystemScope()),
    {},
  );
  return [];
}

/** A middleware that reads orders, the way a membership check might. */
class OrdersMiddleware extends Middleware {
  run() {
    readOrders();
  }
}

const failed: { path: string; error: unknown }[] = [];

/** An api route whose policy refuses everybody, for a loader to query. */
class RootApiRouter extends ApiRouter {
  routes = {
    "/archived-orders": this.get(() => {
      applyPolicies(
        [{ before: () => false }],
        policyContext("Order", "findMany", currentUser(), isSystemScope()),
        {},
      );
      return { orders: [] };
    }),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/orders": this.view("Orders", () => ({ Orders: { orders: readOrders() } })).middleware([
      "auth",
    ]),
    "/orders-by-middleware": this.view("OrdersByMiddleware", () => ({
      OrdersByMiddleware: { orders: [] },
    })).middleware(["auth", "orders"]),
    "/orders-instant": this.view("OrdersInstant", async () => ({
      OrdersInstant: await (Query as any).instant("/archived-orders"),
    })).middleware(["auth"]),
    "/boom": this.view("Boom", () => {
      throw new Error("connection refused");
    }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware, orders: OrdersMiddleware } },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: () => createElement("div"),
        rootRouter: RootViewRouter,
        onRequestFail: (req: HttpRequest, error: unknown) => {
          failed.push({ path: new URL(req.rawRequest.url).pathname, error });
        },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

const bob = { Cookie: "access_token=tok-bob" };
const alice = { Cookie: "access_token=tok-alice" };

/**
 * `app.fetch` answers a view request with either a Response or the render
 * function the server calls with the build's assets. A refusal must be the
 * former: the render function is the page, rendered with a 200.
 */
async function request(path: string, headers: Record<string, string> = {}) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}`, { headers }));
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

beforeEach(() => {
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a policy denial in a view loader", () => {
  test("answers a view-data request 403 with the api's body, and no policy text", async () => {
    const res = await request("/orders.json", bob);
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(text)).toEqual({ error: { message: "Forbidden" } });
    expect(text).not.toMatch(/Order|policy/);
  });

  test("answers a page request with a 403 page", async () => {
    const res = await request("/orders", bob);
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(text).toBe("Forbidden");
  });

  test("hands onRequestFail the original error", async () => {
    await request("/orders.json", bob);
    await request("/orders", bob);

    expect(failed.map(({ path }) => path)).toEqual(["/orders.json", "/orders"]);
    for (const { error } of failed) {
      expect(error).toBeInstanceOf(PolicyDeniedError);
      expect(error).toMatchObject({
        reason: "denied",
        message: "Order.findMany was denied by Order's policy.",
      });
    }
  });

  test("leaves a user the policy allows alone", async () => {
    const res = await request("/orders.json", alice);
    expect(res.status).toBe(200);

    // A page the loader allowed is the render function, not a Response.
    const page: unknown = await app.fetch(
      new Request("http://gemi.dev/orders", { headers: alice }),
    );
    expect(page).toBeTypeOf("function");

    expect(failed).toEqual([]);
  });
});

describe("a policy denial behind a loader's Query.instant", () => {
  test("answers 403 for a view-data request and a page request alike", async () => {
    const data = await request("/orders-instant.json", alice);
    expect(data.status).toBe(403);
    expect(await data.json()).toEqual({ error: { message: "Forbidden" } });

    const page = await request("/orders-instant", alice);
    expect(page.status).toBe(403);
    expect(await page.text()).toBe("Forbidden");

    // The query's rejection is what the view reports, once per request.
    expect(failed.map(({ path }) => path)).toEqual(["/orders-instant.json", "/orders-instant"]);
    for (const { error } of failed) {
      expect(error).toBeInstanceOf(QueryError);
      expect(error).toMatchObject({ status: 403 });
    }
  });
});

describe("a policy denial in a view middleware", () => {
  test("answers 403 for a view-data request and a page request alike", async () => {
    const data = await request("/orders-by-middleware.json", bob);
    expect(data.status).toBe(403);
    expect(await data.json()).toEqual({ error: { message: "Forbidden" } });

    const page = await request("/orders-by-middleware", bob);
    expect(page.status).toBe(403);
    expect(await page.text()).toBe("Forbidden");

    expect(failed.map(({ error }) => error)).toEqual([
      expect.any(PolicyDeniedError),
      expect.any(PolicyDeniedError),
    ]);
  });
});

test("any other throw is still the server's to answer", async () => {
  await expect(app.fetch(new Request("http://gemi.dev/boom.json"))).rejects.toThrow(
    "connection refused",
  );
  expect(failed.map(({ path }) => path)).toEqual(["/boom.json"]);
});
