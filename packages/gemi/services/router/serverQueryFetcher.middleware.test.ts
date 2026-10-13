import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { QueryError } from "../../client/QueryError";
import { Query } from "../../facades/Prefetch";
import { ApiRouter } from "../../http/ApiRouter";
import { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { RequestBreakerError } from "../../http/Error";
import { stateKey } from "../../http/requestState";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A server-side query — `Query.prefetch`/`Query.instant` in a view handler, or
 * a `useQuery` the render discovers — runs its api route in-process. It must
 * run that route's middleware first, as the browser's fetch of the same url
 * does: a handler that reads what its middleware put on `req.state` found
 * nothing, and a route guarded only by its own middleware was answered
 * unguarded.
 */

const owner = stateKey<{ pageId: string }>("owner");

const ran: string[] = [];

/** Puts the page on the request, the way an ownership check would. */
class OwnerMiddleware extends Middleware {
  run() {
    ran.push(`owner:${this.req.params.pageId}`);
    if (this.req.params.pageId === "locked") {
      throw new RequestBreakerError("Not yours", { status: 403 });
    }
    this.req.state.set(owner, { pageId: this.req.params.pageId });
  }
}

class RootApiRouter extends ApiRouter {
  middlewares = ["owner"];
  routes = {
    "/pages/:pageId/assets": this.get((req = new HttpRequest<{}, { pageId: string }>()) => ({
      pageId: req.state.require(owner).pageId,
    })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/instant/:pageId": this.view("Instant", async (req: HttpRequest<{}, { pageId: string }>) => ({
      Instant: await (Query as any).instant("/pages/:pageId/assets", {
        params: { pageId: req.params.pageId },
      }),
    })),
  };
}

const failed: unknown[] = [];

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { owner: OwnerMiddleware } },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
        onRequestFail: (_req: HttpRequest, error: unknown) => {
          failed.push(error);
        },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

async function viewData(path: string) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}.json`));
  expect(result).toBeInstanceOf(Response);
  return (result as Response).text();
}

beforeEach(() => {
  ran.length = 0;
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a server-side query", () => {
  test("runs the api route's middleware before its handler", async () => {
    const body = await viewData("/instant/p1");

    expect(ran).toEqual(["owner:p1"]);
    expect(body).toContain('"pageId":"p1"');
    expect(failed).toEqual([]);
  });

  test("is refused when the api route's middleware breaks", async () => {
    await viewData("/instant/locked");

    expect(ran).toEqual(["owner:locked"]);
    expect(failed).toEqual([expect.any(QueryError)]);
    expect(failed[0]).toMatchObject({ status: 403 });
  });
});
