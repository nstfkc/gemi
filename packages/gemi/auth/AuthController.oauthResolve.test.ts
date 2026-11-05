import { TwitterApi } from "twitter-api-v2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { OAuthClient, OAuthClientContext } from "./oauth/client";

/**
 * Per-request OAuth clients (#1140): a built-in provider's `resolve` picks the
 * client id, the secret and the callback origin for each request, so one
 * server signs users in on many hosts, each with its own OAuth app.
 */

const tenants: Record<string, OAuthClient | null> = {};
const asked: OAuthClientContext[] = [];
let originOverride: string | null = null;

function resolveTenant(ctx: OAuthClientContext) {
  asked.push(ctx);
  const host = new URL(ctx.origin).host;
  const tenant = tenants[host];
  if (!tenant) return null;
  return { ...tenant, origin: originOverride ?? ctx.origin };
}

const auth = {
  config: {
    redirectPath: "/dashboard",
    oauthFailurePath: null as string | null,
    oauthProviders: {} as Record<string, any>,
    onSignIn: async () => {},
    onSignUp: async () => {},
    onUserCreated: async () => {},
  },
  userProvider: {
    findUserBySocialAccount: async () => null,
    findUserByEmailAddress: async () => null,
    findSocialAccounts: async () => [],
    createSocialAccount: async () => ({}),
    transaction: async (fn: () => Promise<unknown>) => await fn(),
    createUser: async (args: any) => ({ id: 99, ...args }),
  },
  createOrUpdateSessionV2: async (args: any) => ({
    token: "t",
    expiresAt: new Date(Date.now() + 60_000),
    user: args,
  }),
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({ expires, httpOnly: true }),
  detectLocale: () => "en-US",
};

vi.mock("../foundation/app", () => ({ app: () => auth }));

const { AuthController } = await import("./AuthController");
const { clearConsumedOAuthStates, openOAuthState } = await import("./oauth/oauthState");
const { GoogleOAuthProvider } = await import("./oauth/GoogleOAuthProvider");
const { XOAuthProvider } = await import("./oauth/XOAuthProvider");
const { InstagramOAuthProvider } = await import("./oauth/InstagramOAuthProvider");
const { enabledOAuthProvider, enabledOAuthProviderNames } = await import("./oauth/providers");

const previousSecret = process.env.SECRET;
const previousHost = process.env.HOST_NAME;
beforeAll(() => {
  process.env.SECRET = "test-secret";
  process.env.HOST_NAME = "https://app.example";
});
afterAll(() => {
  process.env.SECRET = previousSecret;
  process.env.HOST_NAME = previousHost;
});

beforeEach(() => {
  for (const key of Object.keys(tenants)) delete tenants[key];
  tenants["a.example"] = { clientId: "client-a", clientSecret: "secret-a" };
  tenants["b.example"] = { clientId: "client-b", clientSecret: "secret-b" };
  asked.length = 0;
  originOverride = null;
  clearConsumedOAuthStates();
  auth.config.oauthProviders = {
    google: new GoogleOAuthProvider({
      clientId: "static-id",
      clientSecret: "static-secret",
      resolve: resolveTenant,
    }),
    plain: new GoogleOAuthProvider({ clientId: "static-id", clientSecret: "static-secret" }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubGoogle() {
  const calls: { url: string; body: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "at" });
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
        return Response.json({ sub: "g-1", email: "ada@example.com", email_verified: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return calls;
}

async function inRequest(
  url: string,
  provider: string,
  cookie: string,
  fn: () => Promise<unknown>,
  headers: Record<string, string> = {},
) {
  const req = new HttpRequest(
    new Request(url, { headers: { Cookie: cookie, ...headers } }),
    { provider },
    "view",
  );
  return RequestContext.run(req, async () => {
    let result: any;
    let error: any = null;
    let location: string | null = null;
    try {
      result = await fn();
    } catch (caught: any) {
      if (caught?.name === "RedirectError") location = caught.payload.view.headers.Location;
      else error = caught;
    }
    return { result, error, location, cookies: [...RequestContext.getStore().cookies] };
  });
}

function cookieValue(cookies: string[], name: string) {
  const line = cookies.find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : undefined;
}

async function start(origin: string, provider = "google") {
  const run = await inRequest(`${origin}/auth/oauth/${provider}`, provider, "", () =>
    new AuthController().oauthRedirect(),
  );
  if (run.error) throw run.error;
  const name = origin.startsWith("https") ? "__Host-gemi_oauth" : "gemi_oauth";
  const value = cookieValue(run.cookies, name)!;
  const destination = new URL(run.result.destination);
  return { destination, cookie: `${name}=${value}`, payload: openOAuthState(value)! };
}

function finish(origin: string, state: string, cookie: string, provider = "google") {
  return inRequest(
    `${origin}/auth/oauth/${provider}/callback?code=the-code&state=${state}`,
    provider,
    cookie,
    () => new AuthController().oauthCallback(),
  );
}

describe("a provider with resolve", () => {
  test("each host gets its own client and its own callback URL", async () => {
    const a = await start("https://a.example");
    expect(a.destination.searchParams.get("client_id")).toBe("client-a");
    expect(a.destination.searchParams.get("redirect_uri")).toBe(
      "https://a.example/auth/oauth/google/callback",
    );
    expect(a.payload.redirectUri).toBe("https://a.example/auth/oauth/google/callback");

    const b = await start("https://b.example");
    expect(b.destination.searchParams.get("client_id")).toBe("client-b");
    expect(b.destination.searchParams.get("redirect_uri")).toBe(
      "https://b.example/auth/oauth/google/callback",
    );
  });

  test("the callback exchanges the code with the host's client and redirect_uri", async () => {
    const a = await start("https://a.example");
    const calls = stubGoogle();
    const { result, error } = await finish(
      "https://a.example",
      a.destination.searchParams.get("state")!,
      a.cookie,
    );
    expect(error).toBeNull();
    expect(result.redirectTo).toBe("/dashboard");
    const token = calls[0];
    expect(token.body.get("client_id")).toBe("client-a");
    expect(token.body.get("client_secret")).toBe("secret-a");
    expect(token.body.get("redirect_uri")).toBe("https://a.example/auth/oauth/google/callback");
  });

  test("resolve is asked once per request, with the request and its origin", async () => {
    await start("https://a.example");
    expect(asked).toHaveLength(1);
    expect(asked[0].origin).toBe("https://a.example");
    expect(asked[0].req).toBeInstanceOf(HttpRequest);
  });

  test("the origin follows X-Forwarded-Proto", async () => {
    const run = await inRequest(
      "http://a.example/auth/oauth/google",
      "google",
      "",
      () => new AuthController().oauthRedirect(),
      { "x-forwarded-proto": "https" },
    );
    expect(asked[0].origin).toBe("https://a.example");
    expect(new URL(run.result.destination).searchParams.get("redirect_uri")).toBe(
      "https://a.example/auth/oauth/google/callback",
    );
  });

  test("null: the provider is off for the request", async () => {
    const redirect = await inRequest("https://c.example/auth/oauth/google", "google", "", () =>
      new AuthController().oauthRedirect(),
    );
    expect(redirect.error?.payload?.view?.status).toBe(404);
    expect(redirect.cookies).toEqual([]);

    const callback = await inRequest(
      "https://c.example/auth/oauth/google/callback?code=c&state=s",
      "google",
      "__Host-gemi_oauth=whatever",
      () => new AuthController().oauthCallback(),
    );
    expect(callback.error?.payload?.view?.status).toBe(404);

    const listed = await inRequest("https://c.example/", "", "", () =>
      enabledOAuthProviderNames(auth.config.oauthProviders),
    );
    expect(listed.result).toEqual(["plain"]);
    const onA = await inRequest("https://a.example/", "", "", () =>
      enabledOAuthProviderNames(auth.config.oauthProviders),
    );
    expect(onA.result).toEqual(["google", "plain"]);
  });

  test("outside a request a provider with resolve is off", async () => {
    expect(await enabledOAuthProvider(auth.config.oauthProviders, "google", null)).toBeNull();
    expect(await enabledOAuthProvider(auth.config.oauthProviders, "plain", null)).not.toBeNull();
  });

  test("a callback whose redirect_uri resolves differently is refused before the exchange", async () => {
    const a = await start("https://a.example");
    originOverride = "https://elsewhere.example";
    const calls = stubGoogle();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, location } = await finish(
      "https://a.example",
      a.destination.searchParams.get("state")!,
      a.cookie,
    );
    expect(location).toBeNull();
    expect(result.error).toBe("redirect_mismatch");
    expect(calls).toEqual([]);
  });

  test("what resolve leaves out comes from the static config", async () => {
    const google = new GoogleOAuthProvider({
      clientId: "static-id",
      clientSecret: "static-secret",
      redirectPath: "/cb",
      resolve: ({ origin }) => ({ origin }),
    });
    const req = new HttpRequest(new Request("https://a.example/auth/oauth/google"), {}, "view");
    const url = new URL(await google.getRedirectUrl(req));
    expect(url.searchParams.get("client_id")).toBe("static-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://a.example/cb");

    const noOrigin = new GoogleOAuthProvider({
      redirectPath: "/cb",
      resolve: () => ({ clientId: "per-request" }),
    });
    const url2 = new URL(await noOrigin.getRedirectUrl(req));
    expect(url2.searchParams.get("client_id")).toBe("per-request");
    expect(url2.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
  });

  test.each([
    ["a path", "https://a.example/x"],
    ["a non-http scheme", "javascript:alert(1)"],
    ["not a URL", "a.example"],
  ])("an origin that is %s is refused", async (_, origin) => {
    const google = new GoogleOAuthProvider({ resolve: () => ({ origin }) });
    const req = new HttpRequest(new Request("https://a.example/auth/oauth/google"), {}, "view");
    await expect(google.getRedirectUrl(req)).rejects.toThrow(/not an http\(s\) origin/);
  });

  test("a trailing slash on the origin is dropped", async () => {
    const google = new GoogleOAuthProvider({
      resolve: () => ({ origin: "https://a.example/" }),
    });
    const req = new HttpRequest(new Request("https://a.example/"), {}, "view");
    const url = new URL(await google.getRedirectUrl(req));
    expect(url.searchParams.get("redirect_uri")).toBe("https://a.example/auth/oauth/google/callback");
  });
});

describe("a provider without resolve", () => {
  test("is unchanged: HOST_NAME and the static client, synchronously", () => {
    const google = new GoogleOAuthProvider({ clientId: "static-id" });
    const url = google.getRedirectUrl(undefined, {
      state: "s",
      codeChallenge: "c",
      codeChallengeMethod: "S256",
    });
    expect(typeof url).toBe("string");
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("client_id")).toBe("static-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/oauth/google/callback",
    );
  });

  test("a round trip on any host still uses HOST_NAME", async () => {
    const plain = await start("https://a.example", "plain");
    expect(plain.destination.searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/oauth/google/callback",
    );
    const calls = stubGoogle();
    const { result } = await finish(
      "https://a.example",
      plain.destination.searchParams.get("state")!,
      plain.cookie,
      "plain",
    );
    expect(result.redirectTo).toBe("/dashboard");
    expect(calls[0].body.get("client_id")).toBe("static-id");
  });

  test("a round trip started before the upgrade (no redirectUri in the cookie) still finishes", async () => {
    const plain = await start("https://a.example", "plain");
    const { sealOAuthState } = await import("./oauth/oauthState");
    const { redirectUri: _dropped, ...older } = plain.payload;
    const cookie = `__Host-gemi_oauth=${sealOAuthState(older)}`;
    stubGoogle();
    const { result } = await finish(
      "https://a.example",
      plain.destination.searchParams.get("state")!,
      cookie,
      "plain",
    );
    expect(result.redirectTo).toBe("/dashboard");
  });
});

describe("XOAuthProvider with resolve", () => {
  test("the authorization and the exchange use the request's client", async () => {
    const x = new XOAuthProvider({ resolve: resolveTenant, redirectPath: "/x/cb" });
    const req = new HttpRequest(
      new Request("https://b.example/x/cb?code=k"),
      { provider: "x" },
      "view",
    );
    const url = new URL(
      await x.getRedirectUrl(req, { state: "s", codeChallenge: "c", codeChallengeMethod: "S256" }),
    );
    expect(url.searchParams.get("client_id")).toBe("client-b");
    expect(url.searchParams.get("redirect_uri")).toBe("https://b.example/x/cb");

    const login = vi.spyOn(TwitterApi.prototype, "loginWithOAuth2").mockImplementation(
      async function (this: TwitterApi) {
        return {
          client: { v2: { me: async () => ({ data: { id: "x-1", name: "Ada", username: "ada" } }) } },
        } as any;
      },
    );
    const profile = await x.onCallback(req, { state: "s", codeVerifier: "v" });
    expect(profile.providerId).toBe("x-1");
    expect(login).toHaveBeenCalledWith({
      code: "k",
      codeVerifier: "v",
      redirectUri: "https://b.example/x/cb",
    });
    // A client of the tenant's own, not the static one.
    expect(login.mock.contexts[0]).not.toBe(x.client);
  });
});

describe("InstagramOAuthProvider with resolve", () => {
  test("the authorization and the exchange use the request's app", async () => {
    const instagram = new InstagramOAuthProvider({
      resolve: resolveTenant,
      tokenUrl: "https://ig.test/token",
      graphUrl: "https://graph.ig.test",
    });
    const req = new HttpRequest(
      new Request("https://a.example/auth/oauth/instagram/callback?code=k"),
      { provider: "instagram" },
      "view",
    );
    const url = new URL(
      await instagram.getRedirectUrl(req, {
        state: "s",
        codeChallenge: "c",
        codeChallengeMethod: "S256",
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("client-a");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://a.example/auth/oauth/instagram/callback",
    );

    const bodies: URLSearchParams[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const target = input.toString();
        if (target.startsWith("https://ig.test/token")) {
          bodies.push(new URLSearchParams(String(init?.body ?? "")));
          return Response.json({ access_token: "at", user_id: 1 });
        }
        if (target.startsWith("https://graph.ig.test")) {
          return Response.json({ user_id: "ig-1", username: "ada" });
        }
        throw new Error(`unexpected fetch ${target}`);
      }),
    );
    const profile = await instagram.onCallback(req);
    expect(profile.providerId).toBe("ig-1");
    expect(bodies[0].get("client_id")).toBe("client-a");
    expect(bodies[0].get("client_secret")).toBe("secret-a");
    expect(bodies[0].get("redirect_uri")).toBe("https://a.example/auth/oauth/instagram/callback");
  });
});
