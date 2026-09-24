import { describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";

const auth = {
  config: {
    redirectPath: "/dashboard",
    oauthProviders: {
      google: {
        getRedirectUrl: async () => "https://provider.example/authorize",
        onCallback: async () => ({ email: "a@example.com", providerId: "p1" }),
      },
    },
    onSignIn: async () => {},
  },
  userProvider: {
    findUserBySocialAccount: async () => ({ id: 1, email: "a@example.com" }),
  },
  createOrUpdateSessionV2: async () => ({ token: "t", expiresAt: new Date() }),
};

vi.mock("../foundation/app", () => ({ app: () => auth }));

const { AuthController } = await import("./AuthController");

/** Runs `fn` in a request for `url`, returning its result and Set-Cookie lines. */
async function inRequest<T>(url: string, cookie: string, fn: () => Promise<T>) {
  const req = new HttpRequest(
    new Request(url, { headers: { Cookie: cookie } }),
    { provider: "google" },
    "view",
  );
  return RequestContext.run(req, async () => {
    const result = await fn();
    return { result, cookies: [...RequestContext.getStore().cookies] };
  });
}

describe("the intended URL across the OAuth round trip", () => {
  test("the redirect step keeps a forwarded ?redirect= in a Lax cookie", async () => {
    const { cookies } = await inRequest(
      "http://localhost/auth/oauth/google?redirect=%2Finvoices%3Fpage%3D2",
      "",
      () => new AuthController().oauthRedirect(),
    );

    const cookie = cookies.find((c) => c.startsWith("intended_url="));
    expect(cookie).toContain(`intended_url=${encodeURIComponent("/invoices?page=2")}`);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("HttpOnly");
  });

  test("the redirect step ignores an off-origin target", async () => {
    const { cookies } = await inRequest(
      "http://localhost/auth/oauth/google?redirect=https%3A%2F%2Fevil.example",
      "",
      () => new AuthController().oauthRedirect(),
    );

    expect(cookies.some((c) => c.startsWith("intended_url="))).toBe(false);
  });

  test("the callback returns the kept page and clears the cookie", async () => {
    const { result, cookies } = await inRequest(
      "http://localhost/auth/oauth/google/callback?code=c",
      `intended_url=${encodeURIComponent("/invoices?page=2")}`,
      () => new AuthController().oauthCallback(),
    );

    expect(result.redirectTo).toBe("/invoices?page=2");
    expect(cookies).toContainEqual(expect.stringMatching(/^intended_url=; Max-Age=-1/));
  });

  test("the callback falls back to redirectPath, and refuses a forged cookie", async () => {
    const plain = await inRequest("http://localhost/auth/oauth/google/callback?code=c", "", () =>
      new AuthController().oauthCallback(),
    );
    const forged = await inRequest(
      "http://localhost/auth/oauth/google/callback?code=c",
      `intended_url=${encodeURIComponent("//evil.example")}`,
      () => new AuthController().oauthCallback(),
    );

    expect(plain.result.redirectTo).toBe("/dashboard");
    expect(forged.result.redirectTo).toBe("/dashboard");
  });
});
