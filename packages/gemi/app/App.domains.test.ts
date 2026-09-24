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
import { UserProvider } from "../auth/UserProvider";
import { ServiceProvider } from "../support/ServiceProvider";
import { ApiRouteDispatcher } from "../services/router/ApiRouteDispatcher";

process.env.SECRET ??= "test-secret";

const ASK_SECRET = "ask-secret-long-enough";

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
    // An agent's tool call, made from inside the request that started the run.
    "/agent": this.get(async (req = new HttpRequest()) => {
      const res = await resolve(ApiRouteDispatcher).dispatchAs(req, "GET", "/who");
      return { toolCall: await res.json() };
    }),
    "/cookie-domain": this.get((req = new HttpRequest()) => ({
      domain: resolve(AuthManager).cookieDomain(req) ?? null,
    })),
    "/url": this.get(() => ({
      url: (Url as any).forDomain({ subdomain: "admin" }, "/users/:id", { id: 7 }),
    })),
    // Written exactly as `AuthController` writes it, so the `Set-Cookie` the
    // browser would receive is what gets asserted.
    "/sign-in": this.get((req = new HttpRequest()) => {
      req
        .ctx()
        .setCookie(
          "access_token",
          "token",
          resolve(AuthManager).accessTokenCookieOptions(req, new Date(0)),
        );
      return { ok: true };
    }),
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
    // The loader's own query, run in-process against the api rather than over
    // the network — it has to be answered as the same host group.
    "/whoami": this.view("WhoAmI", async () => ({
      WhoAmI: { answer: await (Query as any).instant("/who") },
    })),
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
        ask: { secret: ASK_SECRET },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

/**
 * A kernel whose `custom.resolve` records the hosts it was asked about, so a
 * probe that never reaches the app's own lookups can be told apart from one
 * that did and was refused.
 */
const AskKernel = (calls: string[], { withAsk = true } = {}) =>
  class extends Kernel {
    config = {
      route: {
        api: { rootRouter: RootApi },
        view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
        domains: {
          root: "gemi.dev",
          groups: [{ subdomain: ":tenant", exists: ({ tenant }) => tenant !== "ghost" }],
          custom: {
            group: ":tenant",
            resolve: (host: string) => {
              calls.push(host);
              return host === "app.acme.com" ? { tenant: "acme" } : null;
            },
            cacheTtlMs: 0,
          },
          ...(withAsk ? { ask: { secret: ASK_SECRET } } : {}),
        },
      },
    };
  };

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
  const askWith = async (secret: string | null, domain?: string) => {
    const params = new URLSearchParams();
    if (secret !== null) params.set("secret", secret);
    if (domain !== undefined) params.set("domain", domain);
    const res = (await app.fetch(
      new Request(`http://localhost:5173/__gemi__/domains/ask?${params}`),
    )) as Response;
    return res.status;
  };
  const ask = (domain?: string) => askWith(ASK_SECRET, domain);

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

  // The answer is "is this host a tenant of yours", asked without a session,
  // and each one costs an `exists` or `resolve` call. Without the secret the
  // path must be indistinguishable from any other the app does not route, so
  // it cannot be found by probing — hence the view 404, not a 401.
  // Without the secret the ask must not answer at all: the path falls through
  // to ordinary routing, so what comes back is whatever the app serves for a
  // path it does not have, and it is indistinguishable from any other. The
  // security property is the one asserted here — that the app's own lookups
  // are never reached — since a 200/404 from `ask` is itself the disclosure.
  const askStatus = async (instance: App, query: string) => {
    const result = await instance.fetch(
      new Request(`http://gemi.dev/__gemi__/domains/ask?${query}`),
    );
    return result instanceof Response ? result.status : "not an ask response";
  };

  test("is not served at all without the secret", async () => {
    const calls: string[] = [];
    const watched = new App({ kernel: AskKernel(calls) });

    for (const query of [
      "domain=app.acme.com",
      "secret=wrong&domain=app.acme.com",
      `secret=${ASK_SECRET}x&domain=app.acme.com`,
      `secret=${ASK_SECRET.slice(0, -1)}&domain=app.acme.com`,
    ]) {
      expect(await askStatus(watched, query)).toBe("not an ask response");
    }
    expect(calls).toEqual([]);

    expect(await askStatus(watched, `secret=${ASK_SECRET}&domain=app.acme.com`)).toBe(200);
    expect(calls).toEqual(["app.acme.com"]);
  });

  test("is not served at all when `ask` is left out", async () => {
    const calls: string[] = [];
    const off = new App({ kernel: AskKernel(calls, { withAsk: false }) });
    expect(await askStatus(off, `secret=${ASK_SECRET}&domain=app.acme.com`)).toBe(
      "not an ask response",
    );
    expect(calls).toEqual([]);
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

  // A browser drops a `Secure` cookie from a plain-http origin and makes an
  // exception only for `localhost` — so the loopback root the docs recommend
  // for testing a shared session, `lvh.me`, could not sign in.
  test("the session cookie is Secure by the scheme, not by the host's name", async () => {
    const cookie = async (url: string, headers: Record<string, string> = {}) => {
      const res = (await app.fetch(new Request(url, { headers }))) as Response;
      return res.headers.get("Set-Cookie") ?? "";
    };

    expect(await cookie("http://acme.gemi.dev:5173/api/sign-in")).not.toContain("Secure");
    expect(await cookie("https://acme.gemi.dev/api/sign-in")).toContain("Secure");
    // Behind a proxy that terminates TLS and reaches the app over plain http.
    expect(
      await cookie("http://acme.gemi.dev/api/sign-in", { "x-forwarded-proto": "https" }),
    ).toContain("Secure");
  });

  test("the session cookie carries the shared domain, and a custom host none", async () => {
    const cookie = async (url: string) => {
      const res = (await app.fetch(new Request(url))) as Response;
      return res.headers.get("Set-Cookie") ?? "";
    };

    expect(await cookie("http://acme.gemi.dev/api/sign-in")).toContain("Domain=gemi.dev");
    expect(await cookie("http://gemi.dev/api/sign-in")).toContain("Domain=gemi.dev");
    expect(await cookie("http://app.acme.com/api/sign-in")).not.toContain("Domain=");
  });

  test("Url.forDomain keeps the request's protocol and port", async () => {
    expect((await json("http://acme.gemi.dev:5173/api/url")).body).toEqual({
      url: "http://admin.gemi.dev:5173/users/7",
    });
  });
});

describe("what the servers learn from the app", () => {
  // The dev server and the production server import every view up front. A
  // view only `admin.` routes to is not in the root router's tree, and if it
  // is missing here it is missing from the build, so the admin host renders
  // nothing at all.
  test("the flat component tree covers every host group's views", () => {
    const views = app.getFlatComponentTree();

    expect(views).toContain("Home");
    expect(views).toContain("AdminHome");
    // The same view under two groups is listed once.
    expect(views.filter((view) => view === "Home")).toHaveLength(1);
  });

  test("custom domains let Vite answer on any host", () => {
    expect(app.devAllowedHosts()).toBe(true);
  });

  test("without custom domains it is the root and its subdomains", () => {
    class Subdomains extends Kernel {
      config = {
        route: {
          api: { rootRouter: RootApi },
          view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
          domains: { root: "gemi.dev", groups: [{ subdomain: "admin" }] },
        },
      };
    }

    expect(new App({ kernel: Subdomains }).devAllowedHosts()).toEqual([".gemi.dev"]);
  });

  test("an app with no `route.domains` allows none of its own", () => {
    class NoDomains extends Kernel {
      config = {
        route: {
          api: { rootRouter: RootApi },
          view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
        },
      };
    }

    expect(new App({ kernel: NoDomains }).devAllowedHosts()).toEqual([]);
  });
});

describe("a malformed `route.domains`", () => {
  // `assertValidDomainsConfig` is unit-tested; what matters here is *when* it
  // runs. Building the host groups lazily would let a config that can never
  // route boot cleanly and fail on the first request, long after the deploy
  // looked healthy.
  test("fails the boot, not the first request", async () => {
    class BadRoot extends Kernel {
      config = {
        route: {
          api: { rootRouter: RootApi },
          view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
          domains: { root: "https://gemi.dev" },
        },
      };
    }

    await expect(new App({ kernel: BadRoot }).waitForBoot()).rejects.toThrow(
      /must be a bare hostname/,
    );
  });
});

describe("the ask endpoint answers GET alone", () => {
  // Caddy's `ask` is a GET. Answering any other method would make the
  // endpoint a cheap way to drive the app's `exists`/`resolve` lookups from a
  // request that no proxy would ever send, and CORS lets a browser send some
  // of those cross-origin without a preflight.
  const probe = async (method: string) => {
    const calls: string[] = [];
    const watched = new App({ kernel: AskKernel(calls) });
    const result = await watched.fetch(
      new Request(`http://gemi.dev/__gemi__/domains/ask?secret=${ASK_SECRET}&domain=app.acme.com`, {
        method,
      }),
    );
    return { answered: result instanceof Response ? result.status : "not an ask response", calls };
  };

  test("a GET with the secret is answered", async () => {
    expect(await probe("GET")).toEqual({ answered: 200, calls: ["app.acme.com"] });
  });

  test("a POST, PUT or DELETE is not, and reaches none of the app's lookups", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const { answered, calls } = await probe(method);
      expect({ method, answered, calls }).toEqual({
        method,
        answered: "not an ask response",
        calls: [],
      });
    }
  });
});

/**
 * A request the app makes to itself — a loader's server-side query, an agent's
 * tool call — is served by the right group's routers *and* carries the domain
 * itself, so the handler's `req.domain` names the tenant it is acting for.
 * Without it a tenant-scoped query inside a loader reads as the root's.
 */
describe("the domain reaches the app's own sub-requests", () => {
  /** What the loader's in-process query to `/who` was answered. */
  const serverQueryAnswer = async (url: string) => {
    const res = (await app.fetch(new Request(url))) as Response;
    return JSON.parse(await readAll(res)).prefetchedData["/who"][""];
  };

  test("a server-side query is answered for the page's own tenant", async () => {
    expect(await serverQueryAnswer("http://acme.gemi.dev:5173/whoami.json")).toEqual({
      site: "root",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: false,
    });
  });

  test("a server-side query on a custom domain keeps that domain's params", async () => {
    expect(await serverQueryAnswer("http://app.acme.com/whoami.json")).toEqual({
      site: "root",
      group: ":tenant",
      params: { tenant: "acme" },
      custom: true,
    });
  });

  test("a tool call acts for the tenant whose request started the run", async () => {
    expect((await json("http://acme.gemi.dev/api/agent")).body).toEqual({
      toolCall: {
        site: "root",
        group: ":tenant",
        params: { tenant: "acme" },
        custom: false,
      },
    });
  });

  test("a tool call from a custom domain acts for that domain's tenant", async () => {
    expect((await json("http://app.acme.com/api/agent")).body).toEqual({
      toolCall: {
        site: "root",
        group: ":tenant",
        params: { tenant: "acme" },
        custom: true,
      },
    });
  });
});

/**
 * Signing out has to remove the cookie signing in wrote, and a browser only
 * removes a cookie when the deletion repeats its `Domain` and `Path` — a
 * clear that leaves either out is stored as a *second* cookie and the session
 * survives. With `cookieDomain`, a session that predates it is host-scoped, so
 * there are two cookies to clear, not one.
 */
const deleted: string[] = [];

class StubUsers extends UserProvider {
  async findSession(args: any): Promise<any> {
    return args.token === "tok-alice"
      ? { token: args.token, user: { id: 1, email: "alice@gemi.dev" } }
      : null;
  }
  async deleteSession(args: any) {
    deleted.push(args.token);
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      AuthManager,
      () => new AuthManager({ cookieDomain: "root" }, new StubUsers()),
    );
  }
}

class SignOutKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    auth: { cookieDomain: "root" },
    route: {
      api: { rootRouter: RootApi },
      view: { root: createRoot(() => createElement("div")), rootRouter: RootViews },
      domains: {
        root: "gemi.dev",
        groups: [{ subdomain: ":tenant", exists: () => true }],
        custom: {
          group: ":tenant",
          resolve: (host: string) => (host === "app.acme.com" ? { tenant: "acme" } : null),
        },
      },
    },
  };
}

const signOutApp = new App({ kernel: SignOutKernel });

describe("signing out clears the cookie signing in wrote", () => {
  const cookies = async (url: string, init: RequestInit = {}) => {
    const res = (await signOutApp.fetch(new Request(url, init))) as Response;
    return res.headers.getSetCookie();
  };

  const attributes = (cookie: string) => {
    const [pair, ...rest] = cookie.split("; ");
    const attrs: Record<string, string> = {};
    for (const part of rest) {
      const [key, value = ""] = part.split("=");
      attrs[key.toLowerCase()] = value;
    }
    return { pair, attrs };
  };

  const signOut = (host: string) =>
    cookies(`http://${host}/api/auth/sign-out`, {
      method: "POST",
      headers: { Cookie: "access_token=tok-alice" },
    });

  const isExpired = (attrs: Record<string, string>) =>
    Number(attrs["max-age"] ?? 1) < 0 || new Date(attrs["expires"] ?? 0).getTime() < Date.now();

  test("both the shared-domain cookie and the host-only one are cleared", async () => {
    deleted.length = 0;
    const written = await signOut("acme.gemi.dev");

    expect(deleted).toEqual(["tok-alice"]);
    expect(written).toHaveLength(2);
    for (const cookie of written) {
      const { pair, attrs } = attributes(cookie);
      expect(pair).toBe("access_token=");
      expect(isExpired(attrs)).toBe(true);
    }
    // One repeats what sign-in wrote; the other clears a session from before
    // `cookieDomain` was turned on, which the first one does not touch.
    expect(written.map((cookie) => attributes(cookie).attrs["domain"])).toEqual([
      "gemi.dev",
      undefined,
    ]);
  });

  test("the clear repeats the `Domain` and `Path` sign-in wrote", async () => {
    const signIn = await cookies("http://acme.gemi.dev/api/sign-in");
    expect(signIn).toHaveLength(1);
    const wrote = attributes(signIn[0]).attrs;

    const cleared = attributes((await signOut("acme.gemi.dev"))[0]).attrs;

    expect({ domain: cleared["domain"], path: cleared["path"] }).toEqual({
      domain: wrote["domain"],
      path: wrote["path"],
    });
    expect(cleared["path"]).toBe("/");
    expect(cleared["domain"]).toBe("gemi.dev");
  });

  test("a custom domain, whose cookie carries no domain, is cleared once", async () => {
    const signIn = await cookies("http://app.acme.com/api/sign-in");
    expect(attributes(signIn[0]).attrs["domain"]).toBeUndefined();

    const written = await signOut("app.acme.com");

    expect(written).toHaveLength(1);
    expect(attributes(written[0]).attrs["domain"]).toBeUndefined();
    expect(attributes(written[0]).attrs["path"]).toBe("/");
  });
});
