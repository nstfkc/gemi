import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
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
  "v2.tok-alice": { id: 1, name: "alice" },
  "v2.tok-bob": { id: 2, name: "bob" },
};

// Far from both ends, so `getSession` neither expires nor slides it.
const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const user = SESSIONS[args.token];
    return user ? ({ token: args.token, ...LIVE, user } as any) : null;
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
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
        onRequestFail: (req: HttpRequest, error: unknown) => {
          failed.push({ path: new URL(req.rawRequest.url).pathname, error });
        },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

const bob = { Cookie: "access_token=v2.tok-bob" };
const alice = { Cookie: "access_token=v2.tok-alice" };

/** A `.json` navigation, which `app.fetch` answers with a Response. */
async function request(path: string, headers: Record<string, string> = {}) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}`, { headers }));
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

const renderParams = {
  getStyles: async () => [],
  viewImportMap: {},
  bootstrapModules: [],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

/**
 * A page load: `app.fetch` hands back the renderer the server invokes. A
 * refusal renders the app's `404` view (#726), so it is a renderer too.
 */
async function page(path: string, headers: Record<string, string> = {}) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`, { headers }));
  expect(typeof render).toBe("function");
  return (await (render as any)(renderParams)) as Response;
}

/**
 * What a refused navigation answers since #726: the `404` view, as `is404` in
 * a 200 envelope, so the client router shows it instead of leaving the
 * previous page on screen.
 */
async function expectRefusedNavigation(res: Response) {
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(JSON.parse(text.split("\n")[0]).is404).toBe(true);
  expect(text).not.toMatch(/Order|policy/);
}

/** And a refused page load: the `404` view under a 403. */
async function expectRefusedPage(res: Response) {
  const html = await res.text();
  expect(res.status).toBe(403);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(html).toContain('"is404":true');
  expect(html).not.toMatch(/Order\.findMany|policy/);
}

beforeEach(() => {
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a policy denial in a view loader", () => {
  test("answers a view-data request with the 404 view, and no policy text", async () => {
    await expectRefusedNavigation(await request("/orders.json", bob));
  });

  test("answers a page request with the 404 view under a 403", async () => {
    await expectRefusedPage(await page("/orders", bob));
  });

  test("hands onRequestFail the original error", async () => {
    await request("/orders.json", bob);
    await page("/orders", bob);

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
    await expectRefusedNavigation(await request("/orders-instant.json", alice));
    await expectRefusedPage(await page("/orders-instant", alice));

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
    await expectRefusedNavigation(await request("/orders-by-middleware.json", bob));
    await expectRefusedPage(await page("/orders-by-middleware", bob));

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
