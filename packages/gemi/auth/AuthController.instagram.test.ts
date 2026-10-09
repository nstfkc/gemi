import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";

/**
 * "Sign in with Instagram": `InstagramOAuthProvider` against a stubbed
 * Instagram, and the callback's path for a provider that returns no email
 * (`createUsersWithoutEmail`, `oauthCompleteProfilePath`). Plus Meta's
 * `signed_request` for the deauthorize / data-deletion callbacks.
 */

const IG_ID = "17841400000000123";

const seen: { created: any[]; socialAccounts: any[]; sessions: any[]; userCreated: any[] } = {
  created: [],
  socialAccounts: [],
  sessions: [],
  userCreated: [],
};
let linked: Record<string, any> = {};

const auth = {
  config: {
    redirectPath: "/dashboard",
    oauthFailurePath: null as string | null,
    oauthCompleteProfilePath: null as string | null,
    oauthProviders: {} as Record<string, any>,
    onSignIn: async () => {},
    onSignUp: async () => {},
    onUserCreated: async (user: unknown) => {
      seen.userCreated.push(user);
    },
  },
  userProvider: {
    findUserBySocialAccount: async (provider: string, providerId: string) => linked[`${provider}:${providerId}`] ?? null,
    findUserByEmailAddress: async () => null,
    findSocialAccounts: async () => [],
    createSocialAccount: async (args: any) => {
      seen.socialAccounts.push(args);
      return {};
    },
    transaction: async (fn: () => Promise<unknown>) => await fn(),
    createUser: async (args: any) => {
      seen.created.push(args);
      return { id: 99, ...args };
    },
  },
  createOrUpdateSessionV2: async (args: any) => {
    seen.sessions.push(args);
    return { token: "t", expiresAt: new Date(Date.now() + 60_000), user: args };
  },
  accessTokenCookieOptions: (_req: unknown, expires: Date) => ({ expires, httpOnly: true }),
  detectLocale: () => "en-US",
};

vi.mock("../foundation/app", () => ({ app: () => auth }));

const { AuthController } = await import("./AuthController");
const { clearConsumedOAuthStates } = await import("./oauth/oauthState");
const { InstagramOAuthProvider } = await import("./oauth/InstagramOAuthProvider");
const { parseMetaSignedRequest, MetaSignedRequestError } = await import("./oauth/metaSignedRequest");

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

type Call = { url: URL; init: RequestInit | undefined };
let calls: Call[] = [];
let exchangeStatus = 200;

beforeEach(() => {
  seen.created = [];
  seen.socialAccounts = [];
  seen.sessions = [];
  seen.userCreated = [];
  linked = {};
  calls = [];
  exchangeStatus = 200;
  auth.config.oauthFailurePath = null;
  auth.config.oauthCompleteProfilePath = null;
  auth.config.oauthProviders = {
    instagram: new InstagramOAuthProvider({ clientId: "ig-app", clientSecret: "ig-secret" }),
  };
  clearConsumedOAuthStates();
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.href === "https://api.instagram.com/oauth/access_token") {
      if (exchangeStatus !== 200) {
        return Response.json({ error_type: "OAuthException", code: 400, error_message: "nope" }, { status: 400 });
      }
      return new Response(`{"access_token":"short-1","user_id":${IG_ID},"permissions":["instagram_business_basic"]}`);
    }
    if (url.origin === "https://graph.instagram.com" && url.pathname === "/me") {
      return new Response(`{"user_id":${IG_ID},"username":"acme","id":"990001"}`);
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function inRequest(url: string, cookie: string, fn: () => Promise<unknown>) {
  const req = new HttpRequest(new Request(url, { headers: { Cookie: cookie } }), { provider: "instagram" }, "view");
  return RequestContext.run(req, async () => {
    let result: any;
    let location: string | null = null;
    try {
      result = await fn();
    } catch (error: any) {
      if (error?.name !== "RedirectError") throw error;
      location = error.payload.view.headers.Location;
    }
    return { result, cookies: [...RequestContext.getStore().cookies], location };
  });
}

async function signIn(query = "") {
  const started = await inRequest(`https://app.example/auth/oauth/instagram${query}`, "", () =>
    new AuthController().oauthRedirect(),
  );
  const destination = new URL(started.result.destination);
  const cookies = started.cookies
    .map((line: string) => line.split(";")[0])
    .filter((pair: string) => !pair.endsWith("="))
    .join("; ");
  const state = destination.searchParams.get("state")!;
  const finished = await inRequest(
    `https://app.example/auth/oauth/instagram/callback?code=abc&state=${state}`,
    cookies,
    () => new AuthController().oauthCallback(),
  );
  return { destination, ...finished };
}

describe("InstagramOAuthProvider", () => {
  test("sends the browser to Instagram with the state, comma-separated scopes and no PKCE", async () => {
    const { destination } = await signIn();
    expect(destination.origin + destination.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(destination.searchParams.get("client_id")).toBe("ig-app");
    expect(destination.searchParams.get("redirect_uri")).toBe("https://app.example/auth/oauth/instagram/callback");
    expect(destination.searchParams.get("scope")).toBe("instagram_business_basic");
    expect(destination.searchParams.get("response_type")).toBe("code");
    expect(destination.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(destination.searchParams.has("code_challenge")).toBe(false);
  });

  test("exchanges the code (credentials in the body) and reads /me for the account id", async () => {
    await signIn();
    const exchange = calls.find((c) => c.url.hostname === "api.instagram.com")!;
    expect(exchange.init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(exchange.init?.body)))).toEqual({
      client_id: "ig-app",
      client_secret: "ig-secret",
      grant_type: "authorization_code",
      redirect_uri: "https://app.example/auth/oauth/instagram/callback",
      code: "abc",
    });
    expect(exchange.url.search).toBe("");
    const me = calls.find((c) => c.url.pathname === "/me")!;
    expect(me.url.searchParams.get("access_token")).toBe("short-1");
  });

  test("a first sign-in creates a user with no email, linked by the Instagram account id", async () => {
    const { result } = await signIn();
    expect(result.session).toBeTruthy();
    expect(result.redirectTo).toBe("/dashboard");
    expect(seen.created).toEqual([{ email: null, name: "acme", locale: "en-US" }]);
    expect(seen.socialAccounts[0]).toMatchObject({ provider: "instagram", providerId: IG_ID, userId: 99, username: "acme" });
    expect(seen.socialAccounts[0].email).toBeUndefined();
    expect(seen.userCreated).toHaveLength(1);
    expect(seen.sessions[0]).toEqual({ email: null, id: 99 });
  });

  test("a returning account signs in by its identity, creating nothing", async () => {
    linked[`instagram:${IG_ID}`] = { id: 5, email: "ada@example.com" };
    const { result } = await signIn();
    expect(result.session).toBeTruthy();
    expect(seen.created).toEqual([]);
    expect(seen.sessions[0]).toEqual({ email: "ada@example.com", id: 5 });
  });

  test("oauthCompleteProfilePath sends a user without an email there, with the intended page", async () => {
    auth.config.oauthCompleteProfilePath = "/onboarding/email";
    const { result } = await signIn("?redirect=/projects");
    expect(result.redirectTo).toBe("/onboarding/email?redirect=%2Fprojects");
  });

  test("oauthCompleteProfilePath leaves a user with an email alone", async () => {
    auth.config.oauthCompleteProfilePath = "/onboarding/email";
    linked[`instagram:${IG_ID}`] = { id: 5, email: "ada@example.com" };
    const { result } = await signIn();
    expect(result.redirectTo).toBe("/dashboard");
  });

  test("createUsersWithoutEmail = false refuses an unlinked account with missing_email", async () => {
    auth.config.oauthProviders.instagram.createUsersWithoutEmail = false;
    const { result } = await signIn();
    expect(result).toMatchObject({ session: null, error: "missing_email" });
    expect(seen.created).toEqual([]);
  });

  test("createUsers = false refuses an unlinked account with signup_disabled", async () => {
    auth.config.oauthProviders.instagram.createUsers = false;
    const { result } = await signIn();
    expect(result).toMatchObject({ session: null, error: "signup_disabled" });
    expect(seen.created).toEqual([]);
  });

  test("a refused exchange is exchange_failed", async () => {
    exchangeStatus = 400;
    const { result } = await signIn();
    expect(result).toMatchObject({ session: null, error: "exchange_failed" });
  });

  test("a race lost to a concurrent first sign-in signs into the winner", async () => {
    vi.spyOn(auth.userProvider, "createSocialAccount").mockImplementation(async () => {
      linked[`instagram:${IG_ID}`] = { id: 6, email: null };
      throw new Error("unique constraint");
    });
    const { result } = await signIn();
    expect(result.session).toBeTruthy();
    expect(seen.sessions[0]).toEqual({ email: null, id: 6 });
  });

  test("providers that return no email still refuse by default (Google, custom)", async () => {
    auth.config.oauthProviders.instagram = {
      getRedirectUrl: (_req: unknown, ctx: { state: string }) => `https://provider.example/?state=${ctx.state}`,
      onCallback: async () => ({ providerId: "p1" }),
    };
    const { result } = await signIn();
    expect(result).toMatchObject({ session: null, error: "missing_email" });
  });
});

describe("parseMetaSignedRequest", () => {
  const secret = "app-secret";
  function sign(payload: Record<string, unknown> | string, key = secret) {
    const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", key).update(body).digest("base64url");
    return `${signature}.${body}`;
  }

  test("returns the payload of a correctly signed request, the user id as a string", () => {
    const issued = Math.floor(Date.now() / 1000);
    const raw = `{"algorithm":"HMAC-SHA256","issued_at":${issued},"user_id":${IG_ID}}`;
    expect(parseMetaSignedRequest(sign(raw), secret)).toEqual({
      algorithm: "HMAC-SHA256",
      issued_at: issued,
      user_id: IG_ID,
    });
  });

  test("refuses a signature made with another secret, or a tampered payload", () => {
    const request = sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "other");
    expect(() => parseMetaSignedRequest(request, secret)).toThrow(MetaSignedRequestError);
    const [signature] = sign({ algorithm: "HMAC-SHA256", user_id: "1" }).split(".");
    const forged = `${signature}.${Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "2" })).toString("base64url")}`;
    expect(() => parseMetaSignedRequest(forged, secret)).toThrow(expect.objectContaining({ reason: "bad_signature" }));
  });

  test("refuses another algorithm, an expired request, no user, and garbage", () => {
    expect(() => parseMetaSignedRequest(sign({ algorithm: "none", user_id: "1" }), secret)).toThrow(
      expect.objectContaining({ reason: "unsupported_algorithm" }),
    );
    expect(() =>
      parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1", expires: 1000 }), secret),
    ).toThrow(expect.objectContaining({ reason: "expired" }));
    expect(() => parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256" }), secret)).toThrow(
      expect.objectContaining({ reason: "missing_user" }),
    );
    for (const value of [undefined, "", "abc", "a.b.c", ".x", "x.", "!!.??"]) {
      expect(() => parseMetaSignedRequest(value, secret)).toThrow(expect.objectContaining({ reason: "malformed" }));
    }
    expect(() => parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1" }), "")).toThrow(/app secret/);
  });
});
