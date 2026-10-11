import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { OAuthAuthorizationContext } from "./oauth/OAuthProvider";

/**
 * `{ provider, feature }` in `auth.oauthProviders` (#885): a provider behind a
 * feature flag that is off answers its sign-in routes with a 404 and is left
 * out of `Auth.oauthProviders()`.
 */

const flags: Record<string, boolean> = {};
const evaluated: string[] = [];

function provider(name: string) {
  return {
    getRedirectUrl: async (_req: unknown, ctx: OAuthAuthorizationContext) =>
      `https://${name}.example/authorize?state=${ctx.state}`,
    onCallback: async () => ({ providerId: "p1", email: "ada@example.com", emailVerified: true }),
  };
}

const auth = {
  config: {
    redirectPath: "/dashboard",
    oauthFailurePath: null as string | null,
    oauthProviders: {
      google: provider("google"),
      instagram: { provider: provider("instagram"), feature: "instagram-sign-in" },
      figma: { provider: provider("figma") },
    } as Record<string, any>,
  },
};

const features = {
  enabled: async (key: string) => {
    evaluated.push(key);
    return flags[key] === true;
  },
};

vi.mock("../foundation/app", () => ({
  app: (token?: { token?: string }) => (token?.token === "features" ? features : auth),
}));

const { AuthController } = await import("./AuthController");
const { checkOAuthProviders } = await import("./config");
const { enabledOAuthProvider, enabledOAuthProviderNames } = await import("./oauth/providers");

beforeAll(() => {
  process.env.SECRET ??= "test-secret";
});

beforeEach(() => {
  for (const key of Object.keys(flags)) delete flags[key];
  evaluated.length = 0;
});

async function inRequest(url: string, provider: string, cookie: string, fn: () => Promise<unknown>) {
  const req = new HttpRequest(new Request(url, { headers: { Cookie: cookie } }), { provider }, "view");
  return RequestContext.run(req, async () => {
    let result: unknown;
    let error: any = null;
    try {
      result = await fn();
    } catch (caught) {
      error = caught;
    }
    return { result, error, cookies: [...RequestContext.getStore().cookies] };
  });
}

describe("a provider behind a feature", () => {
  test("off: the redirect answers 404 and writes no cookie", async () => {
    const { error, cookies } = await inRequest(
      "http://localhost/auth/oauth/instagram?redirect=/x",
      "instagram",
      "",
      () => new AuthController().oauthRedirect(),
    );
    expect(error?.payload?.view?.status).toBe(404);
    expect(error?.payload?.api?.status).toBe(404);
    expect(cookies).toEqual([]);
    expect(evaluated).toEqual(["instagram-sign-in"]);
  });

  test("on: the redirect goes to the provider", async () => {
    flags["instagram-sign-in"] = true;
    const { result, error } = await inRequest(
      "http://localhost/auth/oauth/instagram",
      "instagram",
      "",
      () => new AuthController().oauthRedirect(),
    );
    expect(error).toBeNull();
    expect((result as { destination: string }).destination).toMatch(
      /^https:\/\/instagram\.example\/authorize\?state=/,
    );
  });

  test("off: the callback answers 404 and leaves the round trip's cookie alone", async () => {
    const { error, cookies } = await inRequest(
      "http://localhost/auth/oauth/instagram/callback?code=c&state=s",
      "instagram",
      "gemi_oauth=whatever",
      () => new AuthController().oauthCallback(),
    );
    expect(error?.payload?.view?.status).toBe(404);
    expect(cookies).toEqual([]);
  });

  test("a provider with no feature is never evaluated", async () => {
    const { error } = await inRequest(
      "http://localhost/auth/oauth/google",
      "google",
      "",
      () => new AuthController().oauthRedirect(),
    );
    expect(error).toBeNull();
    expect(evaluated).toEqual([]);
  });

  test("an unknown provider is refused as before", async () => {
    const { error } = await inRequest(
      "http://localhost/auth/oauth/nope",
      "nope",
      "",
      () => new AuthController().oauthRedirect(),
    );
    expect(error?.message).toBe("Invalid provider: nope");
  });

  test("a name inherited from Object.prototype is not a provider", async () => {
    expect(await enabledOAuthProvider(auth.config.oauthProviders, "constructor")).toBeNull();
    expect(await enabledOAuthProvider(auth.config.oauthProviders, "__proto__")).toBeNull();
  });
});

describe("listing the providers that are on", () => {
  test("in declaration order, without the ones whose feature is off", async () => {
    expect(await enabledOAuthProviderNames(auth.config.oauthProviders)).toEqual(["google", "figma"]);
    flags["instagram-sign-in"] = true;
    expect(await enabledOAuthProviderNames(auth.config.oauthProviders)).toEqual([
      "google",
      "instagram",
      "figma",
    ]);
  });
});

describe("checkOAuthProviders", () => {
  test("accepts a provider and a { provider, feature }", () => {
    expect(() => checkOAuthProviders(auth.config.oauthProviders)).not.toThrow();
    expect(() => checkOAuthProviders(undefined)).not.toThrow();
  });

  test("refuses an entry with no provider", () => {
    expect(() => checkOAuthProviders({ x: { feature: "a" } as any })).toThrow(
      /auth\.oauthProviders\.x must be an OAuthProvider/,
    );
  });

  test("refuses a feature that is not a key", () => {
    expect(() => checkOAuthProviders({ x: { provider: provider("x"), feature: "" } as any })).toThrow(
      /auth\.oauthProviders\.x\.feature/,
    );
  });
});
