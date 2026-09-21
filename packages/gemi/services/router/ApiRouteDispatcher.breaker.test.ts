import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { RequestBreakerError } from "../../http/Error";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { RequestContext } from "../../http/requestContext";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ServiceProvider } from "../../support/ServiceProvider";

/**
 * A request a middleware rejects: it still ends — `onRequestEnd`, then
 * `destroy()` — and it never reaches the handler, whatever its url looks like.
 */

class NoUsers extends UserProvider {
  async findSession(_args: FindSessionArgs): Promise<SessionWithUser | null> {
    return null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new NoUsers()));
  }
}

class Teapot extends RequestBreakerError {
  constructor() {
    super("teapot");
    this.payload.api = { status: 418, data: { error: "teapot" } };
  }
}

let brokenStore: ReturnType<typeof RequestContext.getStore> | undefined;

class BreakingMiddleware extends Middleware {
  run() {
    brokenStore = RequestContext.getStore();
    throw new Teapot();
  }
}

const handled: string[] = [];
const started: string[] = [];
const ended: string[] = [];

class RootApiRouter extends ApiRouter {
  routes = {
    "/me": this.get(() => {
      handled.push("/me");
      return { ok: true };
    }).middleware(["auth"]),
    "/broken": this.get(() => {
      handled.push("/broken");
      return { ok: true };
    }).middleware(["breaks"]),
    // Framework routes are mounted under `/__gemi__` and are kept out of the
    // app's request hooks; one here lets the break path's exclusion be seen.
    "/__gemi__/broken": this.get(() => {
      handled.push("/__gemi__/broken");
      return { ok: true };
    }).middleware(["breaks"]),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware, breaks: BreakingMiddleware } },
    route: {
      api: {
        rootRouter: RootApiRouter,
        onRequestStart: (req: HttpRequest) => {
          started.push(new URL(req.rawRequest.url).pathname);
        },
        onRequestEnd: (req: HttpRequest) => {
          ended.push(new URL(req.rawRequest.url).pathname);
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
// The dispatcher itself, behind App.fetch's `/api` gate: a request that gate
// would never send here is exactly what the fail-open test needs to build.
const kernel = (app as any).kernel as Kernel;

beforeEach(() => {
  handled.length = 0;
  started.length = 0;
  ended.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a middleware break", () => {
  test("an auth-guarded route answering 401 fires onRequestEnd once", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/me"));

    expect(res.status).toBe(401);
    expect(handled).toEqual([]);
    expect(started).toEqual(["/api/me"]);
    expect(ended).toEqual(["/api/me"]);
  });

  test("ends the request by destroying its store", async () => {
    brokenStore = undefined;
    await app.fetch(new Request("http://gemi.dev/api/broken"));

    expect(brokenStore).toBeDefined();
    expect(brokenStore!.headers).toBeUndefined();
    expect(brokenStore!.cookies).toBeUndefined();
  });

  test("a url without /api still gets the break response, and the handler does not run", async () => {
    const res = await kernel.run(() =>
      kernel.apiRoutes().handleApiRequest(new Request("http://gemi.dev/broken")),
    );

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot" });
    expect(handled).toEqual([]);
    expect(ended).toEqual(["/broken"]);
  });

  test("a /__gemi__ route that breaks fires neither onRequestStart nor onRequestEnd", async () => {
    brokenStore = undefined;
    const res = await app.fetch(new Request("http://gemi.dev/api/__gemi__/broken"));

    expect(res.status).toBe(418);
    expect(handled).toEqual([]);
    // It did end: the store is destroyed even though the hooks stay silent.
    expect(brokenStore).toBeDefined();
    expect(brokenStore!.headers).toBeUndefined();
    expect(started).toEqual([]);
    expect(ended).toEqual([]);
  });
});
