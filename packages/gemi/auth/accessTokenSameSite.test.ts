import { beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";

/**
 * `access_token` is written `SameSite=Lax`. Under the `Strict` default a
 * signed-in user who followed a link to the app from another site (a chat
 * message, an email, a document) arrived without the cookie: `auth` sent them
 * to the sign-in page, and that redirect, part of the same cross-site
 * navigation, went without it too. Every write and every clear goes through
 * `accessTokenCookieOptions`; these run the real one through the controller.
 */

const HASH = await Bun.password.hash("correct horse");
const USER = { id: 1, email: "ada@example.com", password: HASH };

const { AuthManager } = await import("./AuthManager");

const auth = new AuthManager({ cookieDomain: "example.com", onSignIn: async () => {} }, {
  findUserByEmailAddress: async (email: string) => (email === USER.email ? { ...USER } : null),
} as never);
vi.spyOn(auth, "createOrUpdateSession").mockImplementation(
  async () => ({ token: "v2.tok", expiresAt: new Date(Date.now() + 3_600_000) }) as never,
);
vi.spyOn(auth, "createOrUpdateSessionV2").mockImplementation(
  async () => ({ token: "v2.tok", expiresAt: new Date(Date.now() + 3_600_000) }) as never,
);
vi.spyOn(auth, "revokeSession").mockImplementation(async () => null);

// `app()` with no argument is the container, asked only whether a router is
// bound; `app(AuthManager)` is the manager above.
vi.mock("../foundation/app", () => ({
  app: (token?: unknown) => (token ? auth : { bound: () => false }),
}));

const { AuthController } = await import("./AuthController");

async function run(action: "signIn" | "signInV2" | "signOut", body?: Record<string, string>) {
  const req = new HttpRequest(
    new Request(`https://app.example.com/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "access_token=v2.old" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    {},
    "api",
  );
  return RequestContext.run(req, async () => {
    await new AuthController()[action](req as never);
    return [...RequestContext.getStore().cookies].filter((c) => c.startsWith("access_token="));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the access_token cookie", () => {
  test.each(["signIn", "signInV2"] as const)("%s writes it SameSite=Lax", async (action) => {
    const cookies = await run(action, { email: USER.email, password: "correct horse" });

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^access_token=v2\.tok;/);
    expect(cookies[0]).toContain("SameSite=Lax");
    expect(cookies[0]).not.toContain("SameSite=Strict");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
  });

  test("signOut clears it SameSite=Lax, on the shared domain and the host alike", async () => {
    const cookies = await run("signOut");

    // One for `Domain=example.com`, one for a cookie set before `cookieDomain`.
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("Domain=example.com");
    expect(cookies[1]).not.toContain("Domain=");
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^access_token=;/);
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("SameSite=Strict");
    }
  });
});
