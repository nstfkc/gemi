import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../AuthManager";
import { UserProvider } from "../UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../types";
import { createRoot } from "../../client/createRoot";
import { AuthenticationMiddleware } from "../../http/AuthenticationMiddlware";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ServiceProvider } from "../../support/ServiceProvider";
import { ConnectionManager } from "./ConnectionManager";
import { MemoryConnectionStore } from "./ConnectionStore";

/**
 * The provider's redirect back to `/auth/connections/:provider/callback` is a
 * cross-site navigation, so the `SameSite=Strict` session cookie is not on it.
 * Through a whole `App`: that hop gets a same-origin bounce page instead of the
 * sign-in redirect, and the bounced hop — which carries the cookie — stores
 * the connection.
 */

process.env.SECRET ??= "connections-same-site-test-secret";

const SESSIONS: Record<string, { id: number; email: string }> = {
  "v2.tok-ada": { id: 7, email: "ada@example.com" },
};
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

const exchanged: string[] = [];
const figma = {
  config: { scopes: ["files:read"], redirectUri: undefined },
  authorizationUrl: (args: { state: string; codeChallenge: string; redirectUri: string }) => {
    const url = new URL("https://www.figma.com/oauth");
    url.searchParams.set("state", args.state);
    url.searchParams.set("redirect_uri", args.redirectUri);
    return url.toString();
  },
  exchangeCode: async (args: { code: string }) => {
    exchanged.push(args.code);
    return { accessToken: "at", refreshToken: "rt", tokenType: "bearer", expiresAt: null, scopes: ["files:read"], providerAccountId: "acct" };
  },
};

let store: MemoryConnectionStore;

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({ signInPath: "/sign-in" }, new StubUsers()));
    this.app.singleton(
      ConnectionManager,
      () => new ConnectionManager({ providers: { figma } as any, store: () => store }),
    );
  }
}

class RootViewRouter extends ViewRouter {
  routes = {};
}
class RootApiRouter extends ApiRouter {
  routes = {};
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    middleware: { aliases: { auth: AuthenticationMiddleware } },
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(() => createElement("div")), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: AppKernel });
const ORIGIN = "http://gemi.dev";
const session = "access_token=v2.tok-ada";

async function get(path: string, headers: Record<string, string> = {}) {
  const result: unknown = await app.fetch(new Request(`${ORIGIN}${path}`, { headers }));
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

/** Starts a connection as Ada; the state and its cookie, as the provider would hand back. */
async function startConnect() {
  const res = await get("/auth/connections/figma?redirect=/settings", { Cookie: session });
  const location = new URL(res.headers.get("Location")!);
  expect(location.origin).toBe("https://www.figma.com");
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gemi_oauth_connection="))!;
  expect(setCookie).toContain("SameSite=Lax");
  return { state: location.searchParams.get("state")!, stateCookie: setCookie.split(";")[0] };
}

beforeEach(() => {
  store = new MemoryConnectionStore();
  exchanged.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the connection callback, back from the provider", () => {
  test("a cross-site hop without the session cookie gets a same-origin bounce page", async () => {
    const { state, stateCookie } = await startConnect();
    const callback = `/auth/connections/figma/callback?code=abc&state=${state}`;

    // What the browser sends: the Lax state cookie, not the Strict session.
    const res = await get(callback, { Cookie: stateCookie, "Sec-Fetch-Site": "cross-site" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await res.text();
    const bounced = `/auth/connections/figma/callback?code=abc&amp;state=${state}&amp;gemi_same_site=1`;
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${bounced}">`);
    expect(html).not.toContain("<script");
    // Nothing consumed: the state cookie is not cleared, nothing exchanged.
    expect(res.headers.getSetCookie().filter((c) => c.includes("oauth"))).toEqual([]);
    expect(exchanged).toEqual([]);

    // The bounced hop is same-origin, so the session cookie rides along.
    const second = await get(`${callback}&gemi_same_site=1`, {
      Cookie: `${stateCookie}; ${session}`,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(second.status).toBe(307);
    expect(second.headers.get("Location")).toBe("/settings?connection=figma");
    expect(exchanged).toEqual(["abc"]);
    expect(await store.find("7", "figma")).toMatchObject({ accessToken: "at" });
  });

  test("without Sec-Fetch-Site (older browsers) it bounces too", async () => {
    const res = await get("/auth/connections/figma/callback?code=abc&state=x");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("gemi_same_site=1");
  });

  test("the bounced hop still without a session goes to sign-in, not round again", async () => {
    const res = await get("/auth/connections/figma/callback?code=abc&state=x&gemi_same_site=1", {
      "Sec-Fetch-Site": "same-origin",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/sign-in\?redirect=%2Fauth%2Fconnections%2Ffigma%2Fcallback/);
  });

  test("a same-origin hop without a session is signed out: straight to sign-in", async () => {
    const res = await get("/auth/connections/figma/callback?code=abc&state=x", { "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/sign-in\?/);
  });

  test("a cross-site hop that does carry a session is not bounced", async () => {
    const { state, stateCookie } = await startConnect();
    const res = await get(`/auth/connections/figma/callback?code=abc&state=${state}`, {
      Cookie: `${stateCookie}; ${session}`,
      "Sec-Fetch-Site": "cross-site",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/settings?connection=figma");
  });

  test("the connect route itself still requires a session", async () => {
    const res = await get("/auth/connections/figma", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/sign-in\?/);
  });

  test("a .json navigation is never bounced", async () => {
    const res = await get("/auth/connections/figma/callback.json?code=abc&state=x", { "Sec-Fetch-Site": "cross-site" });
    const body = await res.json();
    expect(body.directive).toMatchObject({ kind: "Redirect" });
    expect(body.directive.path).toMatch(/^\/sign-in\?/);
  });
});
