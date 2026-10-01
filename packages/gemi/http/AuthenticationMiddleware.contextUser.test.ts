import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { AuthManager } from "../auth/AuthManager";
import { createRoot } from "../client/createRoot";
import { Auth } from "../facades/Auth";
import { ApiRouter } from "./ApiRouter";
import { AuthenticationMiddleware } from "./AuthenticationMiddlware";
import { Middleware } from "./Middleware";
import { ViewRouter } from "./ViewRouter";
import { Kernel } from "../kernel";

process.env.SECRET ??= "test-secret";

/**
 * Who counts as signed in (#577, #587).
 *
 * - `auth` passes a user that earlier middleware put on the context, with or
 *   without an `access_token` — an SSO header a proxy wrote, an API key.
 * - `auth` and `Auth.user()` read the token the same way, cookie or header, so
 *   a header client is signed in on a route without `auth` too.
 * - A token is still only a claim: one with no live session is refused.
 */

const HOUR = 3_600_000;
const ALICE = { id: 1, email: "alice@example.com" };
const BOB = { id: 2, email: "bob@example.com" };

/**
 * Sessions by token. `v2.expired` has a row whose idle expiry has passed, so
 * only `AuthManager.getSession`'s own expiry check stands between it and a
 * user.
 */
const rows: Record<string, { expiresAt: Date; absoluteExpiresAt: Date; user: typeof ALICE }> = {};
const provider = {
  findSession: vi.fn(async ({ token }: { token: string }) =>
    rows[token] ? { token, ...rows[token], user: { ...rows[token].user } } : null,
  ),
  updateSession: vi.fn(async () => null),
  deleteSession: vi.fn(async ({ token }: { token: string }) => {
    delete rows[token];
  }),
};

beforeEach(() => {
  for (const token of Object.keys(rows)) delete rows[token];
  const now = Date.now();
  rows["v2.good"] = {
    expiresAt: new Date(now + 24 * HOUR),
    absoluteExpiresAt: new Date(now + 48 * HOUR),
    user: ALICE,
  };
  rows["v2.expired"] = {
    expiresAt: new Date(now - HOUR),
    absoluteExpiresAt: new Date(now + 48 * HOUR),
    user: ALICE,
  };
  vi.clearAllMocks();
});

beforeAll(() => {
  vi.spyOn(AuthManager.prototype, "userProvider", "get").mockReturnValue(provider as any);
});

afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * An SSO gate in front of the whole origin: the proxy authenticates the
 * visitor and passes their identity on, with a secret only the proxy knows so
 * a client cannot write the header itself. It verifies before it vouches.
 */
class Sso extends Middleware {
  run() {
    const email = this.req.headers.get("x-sso-email");
    if (this.req.headers.get("x-proxy-secret") !== "proxy-secret" || !email) {
      return;
    }
    const user = [ALICE, BOB].find((u) => u.email === email);
    if (user) {
      this.req.ctx().setUser(user);
    }
  }
}

/** A route middleware that signs a caller in by API key. */
class ApiKey extends Middleware {
  run() {
    if (this.req.headers.get("x-api-key") === "key-for-bob") {
      this.req.ctx().setUser(BOB);
    }
  }
}

const whoami = async () => ({ id: (await Auth.user()).id });

class RootApiRouter extends ApiRouter {
  routes = {
    "/guarded": this.get(whoami).middleware(["auth"]),
    "/open": this.get(whoami),
    "/key-then-auth": this.get(whoami).middleware(["api-key", "auth"]),
    "/auth-then-key": this.get(whoami).middleware(["auth", "api-key"]),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
  };
}

const app = new App({
  kernel: class extends Kernel {
    config = {
      middleware: {
        aliases: { auth: AuthenticationMiddleware, sso: Sso, "api-key": ApiKey },
        global: ["sso"],
      },
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

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://gemi.dev/api${path}`, { headers }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

const SSO_BOB = { "x-proxy-secret": "proxy-secret", "x-sso-email": BOB.email };

describe("a user a global middleware signed in (#577)", () => {
  test("passes auth with no access_token", async () => {
    const res = await get("/guarded", SSO_BOB);

    expect(res).toEqual({ status: 200, body: { id: BOB.id } });
    // Trusted as it is: nothing was looked up.
    expect(provider.findSession).not.toHaveBeenCalled();
  });

  test("is who Auth.user() returns on a route without auth", async () => {
    expect(await get("/open", SSO_BOB)).toEqual({ status: 200, body: { id: BOB.id } });
  });

  test("wins over a token for someone else, as it did before", async () => {
    const res = await get("/guarded", { ...SSO_BOB, access_token: "v2.good" });

    expect(res).toEqual({ status: 200, body: { id: BOB.id } });
  });

  test("a header the gate did not verify signs nobody in", async () => {
    const res = await get("/guarded", { "x-sso-email": BOB.email });

    expect(res.status).toBe(401);
  });
});

describe("a user a route middleware signed in (#577)", () => {
  test("passes auth when the middleware is listed before it", async () => {
    const res = await get("/key-then-auth", { "x-api-key": "key-for-bob" });

    expect(res).toEqual({ status: 200, body: { id: BOB.id } });
  });

  test("does not, when it is listed after: auth has already refused", async () => {
    const res = await get("/auth-then-key", { "x-api-key": "key-for-bob" });

    expect(res.status).toBe(401);
  });
});

describe("the access token, one reader for both (#587)", () => {
  test("the header signs a native client in on a route without auth", async () => {
    expect(await get("/open", { access_token: "v2.good" })).toEqual({
      status: 200,
      body: { id: ALICE.id },
    });
  });

  test("and on a route with it", async () => {
    expect(await get("/guarded", { access_token: "v2.good" })).toEqual({
      status: 200,
      body: { id: ALICE.id },
    });
  });

  test("the cookie still works on both", async () => {
    const cookie = { Cookie: "access_token=v2.good" };

    expect(await get("/open", cookie)).toEqual({ status: 200, body: { id: ALICE.id } });
    expect(await get("/guarded", cookie)).toEqual({ status: 200, body: { id: ALICE.id } });
  });

  test("an empty cookie, a sign-out the client ignored, does not hide the header", async () => {
    const res = await get("/open", { Cookie: "access_token=", access_token: "v2.good" });

    expect(res).toEqual({ status: 200, body: { id: ALICE.id } });
  });

  test("the cookie wins when both are sent", async () => {
    await get("/open", { Cookie: "access_token=v2.good", access_token: "v2.other" });

    expect(provider.findSession).toHaveBeenCalledWith(
      expect.objectContaining({ token: "v2.good" }),
    );
  });

  for (const [what, headers] of [
    ["no token", {}],
    ["an unknown header token", { access_token: "v2.forged" }],
    ["an unknown cookie", { Cookie: "access_token=v2.forged" }],
    ["an expired header token", { access_token: "v2.expired" }],
    ["an expired cookie", { Cookie: "access_token=v2.expired" }],
    ["a pre-v2 token", { access_token: "deadbeef" }],
  ] as const) {
    test(`${what} is refused, with auth and without`, async () => {
      expect((await get("/guarded", headers)).status).toBe(401);
      expect((await get("/open", headers)).status).toBe(401);
    });
  }

  test("an expired session is deleted when it is presented", async () => {
    await get("/open", { access_token: "v2.expired" });

    expect(provider.deleteSession).toHaveBeenCalledWith({ token: "v2.expired" });
  });
});
