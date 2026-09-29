import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import type { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";

/**
 * A view whose record does not exist renders the application's `404` view.
 *
 * Before this, `ViewRouteDispatcher` set `is404` only when no route matched the
 * *path*, so `/pages/:pageId` with an unknown id rendered the page anyway, its
 * prefetch failed during SSR, the server gave up and fell back to client
 * rendering, and the browser retried the same failing query — under a status
 * that told crawlers the page exists.
 *
 * The mechanism under test is deliberately the one the feature gate already
 * uses: clearing the match. `currentPathName` being null is what makes the
 * framework render the `404` view, so a route whose record is missing becomes
 * indistinguishable from one that was never defined — status, view and
 * component tree together.
 *
 * **The `.json` navigation answers 200, not 404, and that is the point.**
 * `loadRoutePayload` returns null for any non-ok response and the caller
 * "leaves the current route on screen" — so a 404 status there would leave the
 * browser sitting on the previous page, which is the bug #614 describes rather
 * than a fix for it. The 404 travels as `is404` in the envelope, which is
 * exactly how an unmatched path and a gated route already reach the client.
 */

process.env.SECRET ??= "record-not-found-view-test-secret";

const failed: { path: string; error: unknown }[] = [];
const loaderRan: string[] = [];

class MissingWorkspaceMiddleware extends Middleware {
  run() {
    throw new RecordNotFoundError("Workspace", "findUniqueOrThrow");
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/ping": this.get(() => ({ ok: true })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    // The shape the issue is about: the handler guards the route with a lookup.
    "/pages/:pageId": this.view("PageBuilder", (req: any) => {
      loaderRan.push(req.params.pageId);
      if (req.params.pageId !== "real") {
        throw new RecordNotFoundError("Page", "findUniqueOrThrow");
      }
      return { PageBuilder: { title: "a real page" } };
    }),
    "/workspace": this.view("Workspace", () => ({ Workspace: {} })).middleware(["workspace"]),
    "/boom": this.view("Boom", () => {
      throw new Error("connection refused");
    }),
    "/fine": this.view("Fine", () => ({ Fine: { ok: true } })),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: { aliases: { workspace: MissingWorkspaceMiddleware } },
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

const renderParams = {
  getStyles: async () => [],
  viewImportMap: {},
  bootstrapModules: [],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

/** A full page load: `app.fetch` hands back the renderer the server invokes. */
async function page(path: string) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return (await (render as any)(renderParams)) as Response;
}

/** A client navigation. */
async function navigate(path: string) {
  const res = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(res).toBeInstanceOf(Response);
  return res as Response;
}

beforeEach(() => {
  failed.length = 0;
  loaderRan.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a loader whose record does not exist", () => {
  test("answers a page load with 404", async () => {
    const res = await page("/pages/nope");
    expect(res.status).toBe(404);
  });

  test("tells the document it is a 404, so the 404 view is what renders", async () => {
    const res = await page("/pages/nope");
    const html = await res.text();
    // What `ClientRouterContext` and `ComponentContext` read to choose
    // `["404"]` over the route's own view.
    expect(html).toContain('"is404":true');
  });

  test("answers a client navigation 200 with is404, not a 404 status", async () => {
    // A 404 here would make `loadRoutePayload` return null and the client would
    // stay on the page it was already showing.
    const res = await navigate("/pages/nope.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is404).toBe(true);
  });

  test("does not report the request as failed", async () => {
    await page("/pages/nope");
    expect(failed).toEqual([]);
  });

  test("leaves a route whose record exists alone", async () => {
    const res = await page("/pages/real");
    expect(res.status).toBe(200);
    expect(loaderRan).toEqual(["real"]);
  });

  test("a client navigation to a record that exists is not a 404", async () => {
    const res = await navigate("/pages/real.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is404).toBe(false);
    // The loader's data is delivered, whatever key the envelope files it
    // under — what matters here is that the route still works normally.
    expect(JSON.stringify(body.data)).toContain("a real page");
  });
});

describe("a view middleware whose record does not exist", () => {
  test("answers a page load with 404 and never runs the loader", async () => {
    const res = await page("/workspace");
    expect(res.status).toBe(404);
    expect(loaderRan).toEqual([]);
  });

  test("answers a client navigation with is404", async () => {
    const res = await navigate("/workspace.json");
    expect(res.status).toBe(200);
    expect((await res.json()).is404).toBe(true);
  });
});

describe("what is still the server's failure", () => {
  test("an ordinary throw in a loader is unaffected", async () => {
    await expect(page("/boom")).rejects.toThrow("connection refused");
    expect(failed).toHaveLength(1);
  });

  test("an ordinary route is untouched", async () => {
    const res = await page("/fine");
    expect(res.status).toBe(200);
    const body = await navigate("/fine.json").then((r) => r.json());
    expect(body.is404).toBe(false);
  });
});
