import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { HttpRequest } from "../http/HttpRequest";
import { ViewRouter } from "../http/ViewRouter";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ViewRouteDispatcher } from "../services/router/ViewRouteDispatcher";

process.env.SECRET ??= "test-secret";

/**
 * `App.staticFiles` (#1015): how the servers serve `public/` and `/assets`
 * to a request's host, from its group's `view` config.
 */

class RootApi extends ApiRouter {
  routes = {
    "/group": this.get((req = new HttpRequest()) => ({ group: req.domain?.group ?? null })),
  };
}

class RootViews extends ViewRouter {
  routes = { "/": this.view("Home") };
}

class ShopViews extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/assets/:path*": this.file(() => new File(["media"], "media.txt")),
  };
}

let existsCalls = 0;

function kernel(domains?: any) {
  return class extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApi },
        view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
        ...(domains ? { domains } : {}),
      },
    };
  };
}

const shopGroup = {
  subdomain: ":shop",
  exists: () => {
    existsCalls++;
    return true;
  },
  view: { rootRouter: ShopViews, publicFiles: false, assetRoutes: true },
};

describe("App.staticFiles (#1015)", () => {
  test("without route.domains, the defaults", async () => {
    const app = new App({ kernel: kernel() });
    expect(await app.staticFiles(new Request("http://localhost/robots.txt"))).toEqual({
      publicFiles: true,
      assetRoutes: false,
    });
  });

  test("a group's own view config answers for its hosts; the root keeps the defaults", async () => {
    const app = new App({ kernel: kernel({ root: "example.test", groups: [shopGroup] }) });
    expect(await app.staticFiles(new Request("http://acme.example.test/robots.txt"))).toEqual({
      publicFiles: false,
      assetRoutes: true,
    });
    expect(await app.staticFiles(new Request("http://example.test/robots.txt"))).toEqual({
      publicFiles: true,
      assetRoutes: false,
    });
    // A host no group serves gets the root's.
    expect(await app.staticFiles(new Request("http://elsewhere.test/robots.txt"))).toEqual({
      publicFiles: true,
      assetRoutes: false,
    });
  });

  test("a group inherits the root view's values", async () => {
    const app = new App({
      kernel: class extends kernel({
        root: "example.test",
        groups: [{ subdomain: "admin", view: { rootRouter: RootViews } }],
      }) {
        constructor() {
          super();
          (this.config.route.view as any).publicFiles = false;
        }
      },
    });
    expect((await app.staticFiles(new Request("http://admin.example.test/robots.txt"))).publicFiles).toBe(false);
  });

  test("the host is resolved once for both the policy and the route", async () => {
    const app = new App({ kernel: kernel({ root: "example.test", groups: [shopGroup] }) });
    existsCalls = 0;
    const req = new Request("http://acme.example.test/api/group");
    await app.staticFiles(req);
    const res = await app.fetch(req);
    expect(await res.json()).toEqual({ group: ":shop" });
    expect(existsCalls).toBe(1);
  });

  test("no host is resolved when no group differs from the root", async () => {
    const app = new App({
      kernel: kernel({ root: "example.test", groups: [{ ...shopGroup, view: { rootRouter: RootViews } }] }),
    });
    existsCalls = 0;
    await app.staticFiles(new Request("http://acme.example.test/robots.txt"));
    expect(existsCalls).toBe(0);
  });

  test("routes under /assets are refused at boot unless the views set assetRoutes", () => {
    const root = createRoot(() => createElement("div"));
    expect(() => new ViewRouteDispatcher({ root, rootRouter: ShopViews })).toThrow(
      /reserved "\/assets" prefix[\s\S]*assetRoutes: true/,
    );
    expect(() => new ViewRouteDispatcher({ root, rootRouter: ShopViews, assetRoutes: true })).not.toThrow();
  });
});
