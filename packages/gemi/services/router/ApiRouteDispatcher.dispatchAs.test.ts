import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
import { app as resolve } from "../../foundation/app";
import * as httpExports from "../../http";
import { ApiRouter } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { Controller } from "../../http/Controller";
import { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import { ViewRouter } from "../../http/ViewRouter";
import { Middleware } from "../../http/Middleware";
import { Kernel } from "../../kernel";
import { isSystemScope, runAsSystem, runAsUser } from "../../orm/context";
import { PolicyDeniedError } from "../../orm/errors";
import { applyPolicies, currentUser, policyContext } from "../../orm/policy";
import { ServiceProvider } from "../../support/ServiceProvider";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";

/**
 * `dispatchAs` driven through a whole `App`: every in-process call below is
 * made from inside a real request to `/agent`, the way an agent's tool call is
 * made from inside the chat request that started the run. The comparisons are
 * against `app.fetch` — a client's request through the same server — because
 * "exactly as a direct HTTP call" is the property, not any particular status.
 */

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

/** Bob may not read orders; everybody else may. Deny-by-default for no user. */
const ordersPolicy = {
  before: (ctx: any) => ctx.user?.id !== 2,
};

function readOrders() {
  applyPolicies(
    [ordersPolicy],
    policyContext("Order", "findMany", currentUser(), isSystemScope()),
    {},
  );
  return { orders: [] };
}

/** A middleware that reads orders, the way a membership check might. */
class OrdersMiddleware extends Middleware {
  run() {
    readOrders();
  }
}

class UploadRequest extends HttpRequest<{ image: File; title: string }, {}> {
  schema = {
    image: { required: "Image is required", file: "Image must be a file" },
    title: { required: "Title is required" },
  };
}

class ProductController extends Controller {
  async create(req = new UploadRequest()) {
    const input = await req.input();
    const image = input.get("image");
    return {
      title: input.get("title"),
      name: image.name,
      type: image.type,
      text: await image.text(),
    };
  }
}

let inside: (req: HttpRequest<any, any>) => Promise<unknown> = async () => ({});
const started: { path: string; modelOriginated: boolean; store: unknown }[] = [];
const ended: string[] = [];
const failed: { path: string; error: unknown }[] = [];

class RootApiRouter extends ApiRouter {
  routes = {
    "/me": this.get(() => {
      const req = new HttpRequest<any, any>();
      // `?.` so that a call skipping `auth` answers rather than crashes: the
      // invariant test must fail by the route *running*, which is the leak.
      return { id: req.ctx().user?.id ?? null, modelOriginated: req.isModelOriginated() };
    }).middleware(["auth"]),
    "/headers": this.get(() => {
      const req = new HttpRequest<any, any>();
      const seen: Record<string, string> = {};
      req.rawRequest.headers.forEach((value, key) => (seen[key] = value));
      return seen;
    }).middleware(["auth"]),
    "/orders": this.get(() => readOrders()).middleware(["auth"]),
    "/public-orders": this.get(() => readOrders()),
    // A denial thrown by a second copy of `gemi/orm`: the same name and shape,
    // a different class object, so `instanceof` alone would miss it.
    "/other-copy-orders": this.get(() => {
      const error = new Error("Order.findMany was denied by Order's policy.");
      error.name = "PolicyDeniedError";
      throw error;
    }),
    "/boom": this.get(() => {
      throw new Error("connection refused");
    }),
    "/orders-by-middleware": this.get(() => ({ orders: [] })).middleware(["auth", "orders"]),
    "/products": this.post(ProductController, "create").middleware(["auth"]),
    "/sets-cookie": this.post(() => {
      const req = new HttpRequest<any, any>();
      req.ctx().setCookie("inner", "1");
      req.ctx().setHeaders("X-Inner", "1");
      return { set: true };
    }),
    "/agent": this.post(() => inside(new HttpRequest<any, any>())),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware, orders: OrdersMiddleware } },
    route: {
      api: {
        rootRouter: RootApiRouter,
        onRequestStart: (req: HttpRequest) => {
          let store: unknown;
          try {
            store = RequestContext.getStore();
          } catch {
            store = undefined;
          }
          started.push({
            path: new URL(req.rawRequest.url).pathname,
            modelOriginated: req.isModelOriginated(),
            store,
          });
        },
        onRequestEnd: (req: HttpRequest) => {
          ended.push(new URL(req.rawRequest.url).pathname);
        },
        onRequestFail: (req: HttpRequest, error: unknown) => {
          failed.push({ path: new URL(req.rawRequest.url).pathname, error });
        },
      },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

/** A client's request, straight to the server. */
function direct(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://gemi.dev/api${path}`, init));
}

/**
 * A request to `/agent` from `headers`, whose handler runs `fn` — the stand-in
 * for an agent run making a tool call as the user who started it.
 */
async function fromAgent<T>(
  headers: Record<string, string>,
  fn: (req: HttpRequest<any, any>, dispatcher: ApiRouteDispatcher) => Promise<T>,
): Promise<{ result: T; outer: Response }> {
  let result!: T;
  inside = async (req) => {
    result = await fn(req, resolve(ApiRouteDispatcher));
    return {};
  };
  const outer = await direct("/agent", { method: "POST", headers });
  return { result, outer };
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  started.length = 0;
  ended.length = 0;
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchAs", () => {
  test("an auth-guarded route rejects an anonymous initiator exactly as a direct call does", async () => {
    const viaHttp = await snapshot(await direct("/me"));

    const { result } = await fromAgent({}, async (req, dispatcher) =>
      snapshot(await dispatcher.dispatchAs(req, "GET", "/me")),
    );

    expect(viaHttp.status).toBe(401);
    expect(result).toEqual(viaHttp);
  });

  test("an authenticated initiator runs the route as that user", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) => snapshot(await dispatcher.dispatchAs(req, "GET", "/me")),
    );

    expect(result).toEqual({ status: 200, body: { id: 1, modelOriginated: true } });
  });

  test("an access_token header is carried as a header", async () => {
    const { result } = await fromAgent({ access_token: "tok-bob" }, async (req, dispatcher) =>
      snapshot(await dispatcher.dispatchAs(req, "GET", "/me")),
    );

    expect(result).toEqual({ status: 200, body: { id: 2, modelOriginated: true } });
  });

  test("copies the credentials and the user agent, and nothing else", async () => {
    const { result } = await fromAgent(
      {
        Cookie: "access_token=tok-alice; csrf_token=c; theme=dark",
        "User-Agent": "agent-test",
        "X-Forwarded-For": "1.2.3.4",
        "Accept-Language": "tr",
        "X-Custom": "nope",
      },
      async (req, dispatcher) => (await dispatcher.dispatchAs(req, "GET", "/headers")).json(),
    );

    expect(result).toEqual({
      cookie: "access_token=tok-alice",
      "user-agent": "agent-test",
    });
  });

  test("a policy that denies the user denies the in-process call too", async () => {
    const bob = { Cookie: "access_token=tok-bob" };
    const viaHttp = await snapshot(await direct("/orders", { headers: bob }));
    expect(viaHttp).toEqual({ status: 403, body: { error: { message: "Forbidden" } } });

    const { result } = await fromAgent(bob, async (req, dispatcher) =>
      snapshot(await dispatcher.dispatchAs(req, "GET", "/orders")),
    );
    expect(result).toEqual(viaHttp);

    const alice = await fromAgent({ Cookie: "access_token=tok-alice" }, async (req, dispatcher) =>
      snapshot(await dispatcher.dispatchAs(req, "GET", "/orders")),
    );
    expect(alice.result).toEqual({ status: 200, body: { orders: [] } });
  });

  test("a multipart route's file rule sees the forwarded File", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) => {
        const form = new FormData();
        form.append("title", "Mug");
        form.append("image", new File(["png-bytes"], "mug.png", { type: "image/png" }));
        return snapshot(await dispatcher.dispatchAs(req, "POST", "/products", form));
      },
    );

    expect(result).toEqual({
      status: 200,
      body: { title: "Mug", name: "mug.png", type: "image/png", text: "png-bytes" },
    });
  });

  test("a multipart route's file rule rejects what is not a file", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) =>
        snapshot(
          await dispatcher.dispatchAs(req, "POST", "/products", {
            title: "Mug",
            image: "gemi_att_invented",
          }),
        ),
    );

    expect(result.status).toBe(400);
    expect(result.body.error.messages.image).toEqual(["Image must be a file"]);
  });

  test("dispatches under the route's real path, so onRequestStart fires", async () => {
    await fromAgent({ Cookie: "access_token=tok-alice" }, async (req, dispatcher) =>
      dispatcher.dispatchAs(req, "GET", "/me"),
    );

    expect(started.map(({ path, modelOriginated }) => ({ path, modelOriginated }))).toEqual([
      { path: "/api/agent", modelOriginated: false },
      { path: "/api/me", modelOriginated: true },
    ]);
    // It starts where a client's request starts: with no request store yet,
    // rather than inside the initiator's.
    expect(started[1]!.store).toBeUndefined();
  });

  test("a query that mentions /__gemi__ does not keep the call out of the lifecycle hooks", async () => {
    const { result } = await fromAgent({ Cookie: "access_token=tok-alice" }, async (req, dispatcher) =>
      snapshot(await dispatcher.dispatchAs(req, "GET", "/me?note=/__gemi__")),
    );

    expect(result).toEqual({ status: 200, body: { id: 1, modelOriginated: true } });
    expect(started.map(({ path }) => path)).toEqual(["/api/agent", "/api/me"]);
    expect(ended).toEqual(["/api/me", "/api/agent"]);
  });

  test("an inbound request cannot mark itself model-originated", async () => {
    const res = await direct("/me", {
      headers: {
        Cookie: "access_token=tok-alice; model_originated=1",
        "X-Gemi-Model-Originated": "1",
        "X-Model-Originated": "true",
      },
    });

    expect(await res.json()).toEqual({ id: 1, modelOriginated: false });
    expect(started[0]!.modelOriginated).toBe(false);
    // The marker's writer is not part of the public http surface.
    expect(Object.keys(httpExports)).not.toContain("markModelOriginated");
  });

  test("the inner call gets its own context, and the outer one is untouched", async () => {
    const { result, outer } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) => {
        const ctx = req.ctx();
        ctx.setCookie("outer", "1");
        // The outer route has no `auth`, so resolve the user the way a guarded
        // route would have, to see whether the inner store inherits it.
        ctx.setUser({ id: 1, name: "alice" });

        const inner = await dispatcher.dispatchAs(req, "POST", "/sets-cookie", {});
        // An unguarded route: the initiator's resolved user must not carry over.
        const unguarded = await dispatcher.dispatchAs(req, "GET", "/public-orders");

        return {
          sameStore: RequestContext.getStore() === ctx,
          outerUser: RequestContext.getStore().user,
          outerCookies: Array.from(RequestContext.getStore().cookies),
          outerInnerHeader: RequestContext.getStore().headers.get("X-Inner"),
          innerSetCookie: inner.headers.getSetCookie(),
          innerHeader: inner.headers.get("X-Inner"),
          unguarded,
        };
      },
    );

    expect(result.sameStore).toBe(true);
    expect(result.outerUser).toEqual({ id: 1, name: "alice" });
    expect(result.outerCookies).toEqual([expect.stringMatching(/^outer=1;/)]);
    expect(result.outerInnerHeader).toBeNull();
    expect(result.innerSetCookie).toEqual([expect.stringMatching(/^inner=1;/)]);
    expect(result.innerHeader).toBe("1");
    expect(result.unguarded.status).toBe(403);
    expect(failed.at(-1)!.error).toMatchObject({ name: "PolicyDeniedError", reason: "no-user" });

    expect(outer.headers.getSetCookie()).toEqual([expect.stringMatching(/^outer=1;/)]);
    expect(outer.headers.get("X-Inner")).toBeNull();
  });

  test("an asSystem block around the call does not reach the route's policies", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) =>
        runAsSystem(() =>
          dispatcher.dispatchAs(req, "GET", "/public-orders").then((res) => res.status),
        ),
    );

    // A client's request to this unguarded route has no user and is denied.
    // Under the initiator's system scope it would have read unscoped.
    expect(result).toBe(403);
    expect(failed.map(({ error }) => error)).toEqual([
      expect.objectContaining({ name: "PolicyDeniedError", reason: "no-user" }),
    ]);
  });

  test("an asUser block for someone else around the call does not swap the route's user", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) =>
        runAsUser({ id: 2, name: "bob" }, () =>
          dispatcher.dispatchAs(req, "GET", "/orders").then(
            (res) => res.status,
            (error) => error,
          ),
        ),
    );

    // Alice may read orders and bob may not: the route sees alice, who
    // started the run, not the bob the initiator was acting as.
    expect(result).toBe(200);
  });

  test.each([
    ["no leading slash", "me"],
    ["a dot segment", "/x/../me"],
    ["a traversal into a framework route", "/../__gemi__/debug/api-routes"],
    ["a framework route", "/__gemi__/debug/api-routes"],
    ["an auth route", "/auth/sign-out"],
    ["the auth root", "/auth"],
    ["a fragment", "/me#x"],
  ])("refuses a path with %s", async (_label, path) => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) =>
        dispatcher.dispatchAs(req, "GET", path).then(
          () => null,
          (error) => (error as Error).message,
        ),
    );

    expect(result).toMatch(/is not an app api path/);
  });

  test("keeps a query string for GET routes", async () => {
    const { result } = await fromAgent(
      { Cookie: "access_token=tok-alice" },
      async (req, dispatcher) => snapshot(await dispatcher.dispatchAs(req, "GET", "/me?x=1")),
    );

    expect(result.status).toBe(200);
  });
});

describe("a policy denial", () => {
  const bob = { Cookie: "access_token=tok-bob" };

  test("answers 403 with no policy text in the body", async () => {
    const res = await direct("/orders", { headers: bob });
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(text)).toEqual({ error: { message: "Forbidden" } });
    expect(text).not.toMatch(/Order|policy/);
  });

  test("hands onRequestFail the original error", async () => {
    await direct("/orders", { headers: bob });

    expect(failed).toHaveLength(1);
    expect(failed[0]!.path).toBe("/api/orders");
    expect(failed[0]!.error).toBeInstanceOf(PolicyDeniedError);
    expect(failed[0]!.error).toMatchObject({
      reason: "denied",
      message: "Order.findMany was denied by Order's policy.",
    });
  });

  test("with no user is a 403 too, and says nothing about asSystem", async () => {
    const res = await direct("/public-orders");
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(text).not.toMatch(/asSystem|Order/);
    expect(failed[0]!.error).toMatchObject({ name: "PolicyDeniedError", reason: "no-user" });
  });

  test("from another copy of the ORM is matched by its name", async () => {
    const res = await direct("/other-copy-orders");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Forbidden" } });
    expect(failed[0]!.error).not.toBeInstanceOf(PolicyDeniedError);
  });

  test("in a middleware answers 403 as well", async () => {
    const res = await direct("/orders-by-middleware", { headers: bob });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Forbidden" } });
    expect(failed[0]!.error).toMatchObject({ name: "PolicyDeniedError", reason: "denied" });

    const alice = await direct("/orders-by-middleware", {
      headers: { Cookie: "access_token=tok-alice" },
    });
    expect(alice.status).toBe(200);
  });

  test("is the only throw answered this way", async () => {
    await expect(direct("/boom")).rejects.toThrow("connection refused");
    expect(failed.map(({ path }) => path)).toEqual(["/api/boom"]);
  });
});
