import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { AuthManager } from "./AuthManager";
import { UserProvider } from "./UserProvider";
import { createRoot } from "../client/createRoot";
import { Auth } from "../facades/Auth";
import { ApiRouter } from "../http/ApiRouter";
import { AuthenticationMiddleware } from "../http/AuthenticationMiddlware";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { unhandledErrorResponse } from "../server/unhandledError";

process.env.SECRET ??= "test-secret";

/**
 * A session lookup that fails is not "no session" (#1120). `findSession` used
 * to catch every error and return null, so a database blip answered `auth`
 * routes with a 401 `authentication` and sent navigations to sign-in — the
 * same answer a client gets for a session that really ended.
 */

const HOUR = 3_600_000;
const ALICE = { id: 1, email: "alice@example.com" };

describe("UserProvider.findSession", () => {
  function providerWith(findUnique: () => Promise<unknown>) {
    const provider = new UserProvider({ Session: { findUnique } } as any);
    (provider as any).run = (fn: () => unknown) => fn();
    return provider;
  }

  test("a token with no row is no session", async () => {
    const provider = providerWith(async () => null);

    expect(await provider.findSession({ token: "v2.gone", userAgent: "" } as any)).toBeNull();
  });

  test("a lookup error propagates instead of reading as signed out", async () => {
    const provider = providerWith(async () => {
      throw new Error("Can't reach database server");
    });

    await expect(
      provider.findSession({ token: "v2.good", userAgent: "" } as any),
    ).rejects.toThrow("Can't reach database server");
  });

  test("no token is not a lookup", async () => {
    const findUnique = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const provider = providerWith(findUnique);

    expect(await provider.findSession({ token: "", userAgent: "" } as any)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("a failing lookup through the request pipeline", () => {
  let failing = false;
  // The real provider, over models that fail on demand: the catch being
  // tested lived in `UserProvider.findSession` itself.
  const row = () => ({
    token: "v2.good",
    expiresAt: new Date(Date.now() + 24 * HOUR),
    absoluteExpiresAt: new Date(Date.now() + 48 * HOUR),
    user: { ...ALICE },
  });
  const provider = new UserProvider({
    Session: {
      findUnique: async ({ where }: { where: { token: string } }) => {
        if (failing) throw new Error("Can't reach database server");
        return where.token === "v2.good" ? row() : null;
      },
      update: async () => row(),
      deleteMany: async () => ({ count: 0 }),
    },
  } as any);
  (provider as any).run = (fn: () => unknown) => fn();

  beforeAll(() => {
    vi.spyOn(AuthManager.prototype, "userProvider", "get").mockReturnValue(provider as any);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    failing = false;
  });

  class RootApiRouter extends ApiRouter {
    routes = {
      "/guarded": this.get(async () => ({ id: (await Auth.user()).id })).middleware(["auth"]),
      "/maybe": this.get(async () => ({ id: (await Auth.userOrNull())?.id ?? null })),
    };
  }

  class RootViewRouter extends ViewRouter {
    routes = {
      "/": this.view("Home", () => ({})),
      "/dashboard": this.view("Dashboard", () => ({})).middleware(["auth"]),
    };
  }

  const app = new App({
    kernel: class extends Kernel {
      config = {
        middleware: { aliases: { auth: AuthenticationMiddleware } },
        route: {
          api: { rootRouter: RootApiRouter },
          view: {
            root: createRoot(() => createElement("div")),
            rootRouter: RootViewRouter,
          },
        },
      };
    },
  });

  const cookie = { Cookie: "access_token=v2.good" };

  /** As the production server answers: what `app.fetch` throws becomes its 500. */
  async function serve(url: string, headers: Record<string, string> = cookie) {
    const req = new Request(`http://gemi.dev${url}`, { headers });
    try {
      const res: any = await app.fetch(req);
      return typeof res === "function" ? await res() : (res as Response);
    } catch (err) {
      return unhandledErrorResponse(err, new URL(req.url).pathname, () => {});
    }
  }

  test("an `auth` API route answers 500, not 401", async () => {
    expect((await serve("/api/guarded")).status).toBe(200);

    failing = true;
    const res = await serve("/api/guarded");

    expect(res.status).toBe(500);
  });

  test("Auth.userOrNull() throws rather than answering null", async () => {
    failing = true;
    const res = await serve("/api/maybe");

    expect(res.status).toBe(500);
  });

  test("a page navigation is not sent to sign-in", async () => {
    failing = true;
    const res = await serve("/dashboard.json");
    const body = await res.json().catch(() => null);

    expect(body?.directive?.kind).not.toBe("Redirect");
    expect(res.status).toBe(500);
  });

  test("a page load is not redirected to sign-in", async () => {
    failing = true;
    const res = await serve("/dashboard");

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  test("a missing session is still a 401 and a sign-in redirect", async () => {
    const api = await serve("/api/guarded", { Cookie: "access_token=v2.gone" });
    const page = await serve("/dashboard", { Cookie: "access_token=v2.gone" });

    expect(api.status).toBe(401);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/auth/sign-in?redirect=%2Fdashboard");
  });
});
