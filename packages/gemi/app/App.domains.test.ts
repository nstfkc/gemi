import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { HttpRequest } from "../http/HttpRequest";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { Query } from "../facades/Prefetch";
import { Url } from "../facades/Url";
import { app as resolve } from "../foundation/app";
import { AuthManager } from "../auth/AuthManager";

process.env.SECRET ??= "test-secret";

/**
 * `route.domains`: which host group `App.fetch` hands a request to, what the
 * handlers learn of it, and the TLS ask endpoint in front of it all.
 */

const who = (site: string) =>
  ApiRouter.prototype.get.call(ApiRouter.prototype, (req = new HttpRequest()) => ({
    site,
    group: req.domain?.group ?? null,
    params: req.domain?.params ?? null,
    custom: req.domain?.custom ?? null,
  }));

class RootApi extends ApiRouter {
  routes = {
    "/who": who("root"),
    "/only-root": this.get(() => ({ ok: true })),
    "/cookie-domain": this.get((req = new HttpRequest()) => ({
      domain: resolve(AuthManager).cookieDomain(req) ?? null,
    })),
    "/url": this.get(() => ({
      url: (Url as any).forDomain({ subdomain: "admin" }, "/users/:id", { id: 7 }),
    })),
  };
}

class AdminApi extends ApiRouter {
  routes = {
    "/who": who("admin"),
  };
}

class FallbackApi extends ApiRouter {
  routes = {
    "/who": who("fallback"),
  };
}

class RootViews extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({ Home: { site: "root" } })),
  };
}

class AdminViews extends ViewRouter {
  routes = {
    "/": this.view("AdminHome", async () => ({
      // Server-side, so it must run against the admin api — the root one has a
      // `/who` too, and would answer "root".
      AdminHome: { answer: await (Query as any).instant("/who") },
    })),
  };
}

class AppKernel extends Kernel {
  config = {
    auth: { cookieDomain: "root" },
    route: {
      api: { rootRouter: RootApi },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViews,
      },
      domains: {
        root: "gemi.dev",
        groups: [
          { subdomain: "admin", api: { rootRouter: AdminApi }, view: { rootRouter: AdminViews } },
          { subdomain: ":tenant", exists: ({ tenant }) => tenant !== "ghost" },
        ],
        custom: {
          group: ":tenant",
          resolve: (host: string) => (host === "app.acme.com" ? { tenant: "acme" } : null),
          fallback: { api: { rootRouter: FallbackApi } },
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

async function json(url: string) {
  const res = (await app.fetch(new Request(url))) as Response;
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

async function readAll(res: Response) {
  return await new Response(res.body).text();
}

describe("App.fetch routes by host", () => {
  test("the root host runs the root routers", async () => {
    expect((await json("http://gemi.dev/api/who")).body).toEqual({
      site: "root",
      group: "",
      params: {},
      custom: false,
    });
  });

  test("a param subdomain runs the root routers with its param", async () => {
    expect((await json("http://acme.gemi.dev:5173/api/who")).body).toEqual({
      site: "root",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: false,
    });
  });

  test("a group with its own routers sees none of the root's", async () => {
    expect((await json("http://admin.gemi.dev/api/who")).body).toMatchObject({ site: "admin" });
    expect((await json("http://admin.gemi.dev/api/only-root")).status).toBe(404);
    expect((await json("http://gemi.dev/api/only-root")).status).toBe(200);
  });

  test("a param subdomain `exists` rejects is an unknown host", async () => {
    expect(await json("http://ghost.gemi.dev/api/who")).toEqual({
      status: 404,
      body: "Unknown host",
    });
  });

  test("a subdomain nothing declares is an unknown host", async () => {
    expect((await json("http://a.b.gemi.dev/api/who")).status).toBe(404);
  });

  test("a resolved custom domain is served as its group", async () => {
    expect((await json("http://app.acme.com/api/who")).body).toEqual({
      site: "root",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: true,
    });
  });

  test("an unresolved custom domain goes to the fallback", async () => {
    expect((await json("http://random.org/api/who")).body).toMatchObject({
      site: "fallback",
      group: "*",
    });
  });
});

describe("views on a host group", () => {
  test("the document tells the client which domain it is on", async () => {
    const render = await app.fetch(new Request("http://acme.gemi.dev:5173/"));
    const html = await (await (render as any)(renderParams)).text();
    expect(html).toContain(
      '"domain":{"host":"acme.gemi.dev","group":":tenant","params":{"tenant":"acme"},"custom":false,"root":"gemi.dev","origin":"http://acme.gemi.dev:5173"}',
    );
  });

  test("a server-side query runs against the group's own api", async () => {
    const res = (await app.fetch(new Request("http://admin.gemi.dev/.json"))) as Response;
    const body = await readAll(res);
    expect(body).toContain('"answer":{"site":"admin"');
  });
});

describe("the TLS ask endpoint", () => {
  const ask = async (domain?: string) => {
    const query = domain === undefined ? "" : `?domain=${encodeURIComponent(domain)}`;
    const res = (await app.fetch(
      new Request(`http://localhost:5173/__gemi__/domains/ask${query}`),
    )) as Response;
    return res.status;
  };

  test("approves the hosts the app serves in its own right", async () => {
    expect(await ask("gemi.dev")).toBe(200);
    expect(await ask("admin.gemi.dev")).toBe(200);
    expect(await ask("acme.gemi.dev")).toBe(200);
    expect(await ask("app.acme.com")).toBe(200);
  });

  test("refuses the rest, including hosts only the fallback would serve", async () => {
    expect(await ask("ghost.gemi.dev")).toBe(404);
    expect(await ask("random.org")).toBe(404);
    expect(await ask("")).toBe(404);
    expect(await ask()).toBe(404);
  });
});

describe("domain-aware cookies and URLs", () => {
  test("the session cookie spans the root's subdomains, but not a custom domain", async () => {
    expect((await json("http://acme.gemi.dev/api/cookie-domain")).body).toEqual({
      domain: "gemi.dev",
    });
    expect((await json("http://gemi.dev/api/cookie-domain")).body).toEqual({
      domain: "gemi.dev",
    });
    expect((await json("http://app.acme.com/api/cookie-domain")).body).toEqual({ domain: null });
  });

  test("Url.forDomain keeps the request's protocol and port", async () => {
    expect((await json("http://acme.gemi.dev:5173/api/url")).body).toEqual({
      url: "http://admin.gemi.dev:5173/users/7",
    });
  });
});
