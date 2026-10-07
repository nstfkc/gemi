import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../http/HttpRequest";
import { RequestContext } from "../http/requestContext";
import type { OAuthAuthorizationContext, OAuthCallbackContext } from "./oauth/OAuthProvider";

/**
 * The OAuth round trip's `state` and PKCE (#822): `oauthRedirect` mints both
 * into a signed cookie, and `oauthCallback` refuses a callback that this
 * browser did not start. Plus the smaller parts of #822: verified emails only,
 * normalised emails, `redirectPath`, and a failure the app can act on.
 */

const seen: {
  authorize: OAuthAuthorizationContext[];
  callback: OAuthCallbackContext[];
  lookups: string[];
  created: any[];
} = { authorize: [], callback: [], lookups: [], created: [] };

let profile: Record<string, unknown> = {};
let callbackError: Error | null = null;
let knownUsers: Record<string, { id: number; email: string }> = {};

const scripted = {
  getRedirectUrl: async (_req: unknown, ctx: OAuthAuthorizationContext) => {
    seen.authorize.push(ctx);
    const url = new URL("https://provider.example/authorize");
    url.searchParams.set("state", ctx.state);
    url.searchParams.set("code_challenge", ctx.codeChallenge);
    return url.toString();
  },
  onCallback: async (_req: unknown, ctx: OAuthCallbackContext) => {
    seen.callback.push(ctx);
    if (callbackError) throw callbackError;
    return profile;
  },
};

const auth = {
  config: {
    redirectPath: "/dashboard",
    oauthFailurePath: null as string | null,
    oauthProviders: { scripted, other: scripted } as Record<string, any>,
    onSignIn: async () => {},
    onSignUp: async () => {},
    onUserCreated: async () => {},
  },
  userProvider: {
    findUserBySocialAccount: async () => null,
    findUserByEmailAddress: async (email: string) => {
      seen.lookups.push(email);
      return knownUsers[email] ?? null;
    },
    findSocialAccounts: async () => [],
    createSocialAccount: async () => ({}),
    transaction: async (fn: () => Promise<unknown>) => await fn(),
    createUser: async (args: any) => {
      seen.created.push(args);
      return { id: 99, ...args };
    },
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
const { clearConsumedOAuthStates, openOAuthState, sealOAuthState } = await import(
  "./oauth/oauthState"
);
const { OAuthCallbackError } = await import("./oauth/OAuthProvider");
const { GoogleOAuthProvider } = await import("./oauth/GoogleOAuthProvider");
const { XOAuthProvider } = await import("./oauth/XOAuthProvider");

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
  seen.authorize = [];
  seen.callback = [];
  seen.lookups = [];
  seen.created = [];
  profile = { providerId: "p1", email: "ada@example.com", emailVerified: true };
  callbackError = null;
  knownUsers = {};
  auth.config.oauthFailurePath = null;
  clearConsumedOAuthStates();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Result = { result: any; cookies: string[]; location: string | null };

async function inRequest(
  url: string,
  cookie: string,
  provider: string,
  fn: () => Promise<unknown>,
  headers: Record<string, string> = {},
): Promise<Result> {
  const req = new HttpRequest(
    new Request(url, { headers: { Cookie: cookie, ...headers } }),
    { provider },
    "view",
  );
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

function cookieValue(cookies: string[], name: string) {
  const line = cookies.find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : undefined;
}

/** `oauthRedirect` for `provider`, as a browser at `origin` would start it. */
async function start(provider = "scripted", origin = "http://localhost", query = "") {
  const { result, cookies } = await inRequest(
    `${origin}/auth/oauth/${provider}${query}`,
    "",
    provider,
    () => new AuthController().oauthRedirect(),
  );
  const name = origin.startsWith("https") ? "__Host-gemi_oauth" : "gemi_oauth";
  const destination = new URL(result.destination);
  return {
    state: destination.searchParams.get("state")!,
    cookie: `${name}=${cookieValue(cookies, name)}`,
    setCookies: cookies,
    destination,
  };
}

function finish(query: string, cookie: string, provider = "scripted", origin = "http://localhost") {
  return inRequest(
    `${origin}/auth/oauth/${provider}/callback${query}`,
    cookie,
    provider,
    () => new AuthController().oauthCallback(),
  );
}

describe("the redirect step", () => {
  test("hands the provider a random state and an S256 challenge, and keeps them in a Lax HttpOnly cookie", async () => {
    const a = await start();
    const b = await start();

    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).not.toBe(b.state);
    expect(seen.authorize[0].codeChallengeMethod).toBe("S256");

    const line = a.setCookies.find((c) => c.startsWith("gemi_oauth="))!;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Max-Age=600");

    // The cookie holds the verifier the challenge was made from, and is
    // signed: the payload alone is not enough.
    const payload = openOAuthState(cookieValue(a.setCookies, "gemi_oauth"))!;
    expect(payload.state).toBe(a.state);
    expect(payload.provider).toBe("scripted");
    const challenge = createHash("sha256").update(payload.codeVerifier).digest("base64url");
    expect(seen.authorize[0].codeChallenge).toBe(challenge);
  });

  test("on https the cookie is __Host- prefixed and Secure", async () => {
    const { setCookies } = await start("scripted", "https://app.example");
    const line = setCookies.find((c) => c.startsWith("__Host-gemi_oauth="))!;
    expect(line).toContain("Secure");
    expect(line).toContain("Path=/");
    expect(line).not.toContain("Domain=");
  });
});

describe("the callback's state check", () => {
  test("a matching state signs in, and the PKCE verifier reaches the provider", async () => {
    const { state, cookie } = await start();
    const { result, cookies } = await finish(`?code=c&state=${state}`, cookie);

    expect(result.session).not.toBeNull();
    expect(result.redirectTo).toBe("/dashboard");
    const payload = openOAuthState(cookie.split("=")[1])!;
    expect(seen.callback).toEqual([{ state, codeVerifier: payload.codeVerifier }]);
    // Single use: the cookie is deleted.
    expect(cookies).toContainEqual(expect.stringMatching(/^gemi_oauth=; Max-Age=-1/));
  });

  test("a callback with no state cookie is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A round trip started in another browser: its code and its state.
    const other = await start();
    const { result } = await finish(`?code=other-code&state=${other.state}`, "");

    expect(result).toEqual({ session: null, error: "missing_state", redirectTo: null });
    expect(seen.callback).toEqual([]);
  });

  test("a callback with no state parameter is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie } = await start();
    const { result, cookies } = await finish("?code=c", cookie);

    expect(result.error).toBe("missing_state");
    expect(seen.callback).toEqual([]);
    expect(cookies).toContainEqual(expect.stringMatching(/^gemi_oauth=; Max-Age=-1/));
  });

  test("a state that is not the cookie's is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mine = await start();
    const other = await start();
    const { result } = await finish(`?code=other-code&state=${other.state}`, mine.cookie);

    expect(result.error).toBe("invalid_state");
    expect(seen.callback).toEqual([]);
  });

  test("a replayed state is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await start();
    const first = await finish(`?code=c&state=${state}`, cookie);
    expect(first.result.session).not.toBeNull();

    // The same cookie presented again, as if the deletion had been ignored.
    const second = await finish(`?code=c&state=${state}`, cookie);
    expect(second.result.error).toBe("invalid_state");
    // And without it, as a browser that honoured the deletion sends it.
    const third = await finish(`?code=c&state=${state}`, "");
    expect(third.result.error).toBe("missing_state");
    expect(seen.callback).toHaveLength(1);
  });

  test("a forged or tampered cookie is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await start();
    const payload = openOAuthState(cookie.split("=")[1])!;
    const body = Buffer.from(JSON.stringify({ ...payload, codeVerifier: "x" })).toString(
      "base64url",
    );
    const tampered = `gemi_oauth=${body}.${cookie.split(".")[1]}`;
    const unsigned = `gemi_oauth=${body}`;

    expect((await finish(`?code=c&state=${state}`, tampered)).result.error).toBe("invalid_state");
    expect((await finish(`?code=c&state=${state}`, unsigned)).result.error).toBe("invalid_state");
    expect(seen.callback).toEqual([]);
  });

  test("a state minted for another provider is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await start("other");
    const { result } = await finish(`?code=c&state=${state}`, cookie, "scripted");
    expect(result.error).toBe("invalid_state");
  });

  test("an expired state is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const expired = sealOAuthState({
      provider: "scripted",
      state: "s",
      codeVerifier: "v",
      expiresAt: Date.now() - 1,
    });
    const { result } = await finish("?code=c&state=s", `gemi_oauth=${expired}`);
    expect(result.error).toBe("expired_state");
  });

  test("on https only the __Host- cookie counts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await start("scripted", "https://app.example");
    const plain = cookie.replace("__Host-gemi_oauth", "gemi_oauth");

    const refused = await finish(`?code=c&state=${state}`, plain, "scripted", "https://app.example");
    expect(refused.result.error).toBe("missing_state");
    const accepted = await finish(`?code=c&state=${state}`, cookie, "scripted", "https://app.example");
    expect(accepted.result.session).not.toBeNull();
    expect(accepted.cookies).toContainEqual(
      expect.stringMatching(/^__Host-gemi_oauth=; Max-Age=-1; HttpOnly; Secure/),
    );
  });
});

describe("the email", () => {
  test("an unverified email neither signs into an existing user nor creates one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    knownUsers["ada@example.com"] = { id: 1, email: "ada@example.com" };
    profile = { providerId: "p1", email: "ada@example.com", emailVerified: false };

    const { state, cookie } = await start();
    const { result } = await finish(`?code=c&state=${state}`, cookie);

    expect(result.error).toBe("email_not_verified");
    expect(result.session).toBeNull();
    expect(seen.lookups).toEqual([]);
    expect(seen.created).toEqual([]);
  });

  test("a provider that cannot tell keeps signing in by email", async () => {
    knownUsers["ada@example.com"] = { id: 1, email: "ada@example.com" };
    profile = { providerId: "p1", email: "ada@example.com" };

    const { state, cookie } = await start();
    const { result } = await finish(`?code=c&state=${state}`, cookie);
    expect(result.session.user.id).toBe(1);
  });

  test("is trimmed and lower-cased before it is looked up and stored", async () => {
    knownUsers["ada@example.com"] = { id: 1, email: "ada@example.com" };
    profile = { providerId: "p1", email: "  Ada@Example.COM ", emailVerified: true };

    const { state, cookie } = await start();
    const { result } = await finish(`?code=c&state=${state}`, cookie);

    expect(seen.lookups).toEqual(["ada@example.com"]);
    expect(result.session.user.id).toBe(1);
  });

  test("a new user is created with the normalised email", async () => {
    profile = { providerId: "p1", email: "Grace@Example.com", emailVerified: true };

    const { state, cookie } = await start();
    await finish(`?code=c&state=${state}`, cookie);

    expect(seen.created).toMatchObject([{ email: "grace@example.com" }]);
  });

  test("a user stored as the provider spelled it is still found", async () => {
    knownUsers["Maria@Example.com"] = { id: 7, email: "Maria@Example.com" };
    profile = { providerId: "p1", email: "Maria@Example.com", emailVerified: true };

    const { state, cookie } = await start();
    const { result } = await finish(`?code=c&state=${state}`, cookie);

    expect(seen.lookups).toEqual(["maria@example.com", "Maria@Example.com"]);
    expect(result.session.user.id).toBe(7);
    expect(seen.created).toEqual([]);
  });
});

describe("a provider that does not link by email", () => {
  const unlinked = { ...scripted, linkByEmail: false };
  beforeEach(() => {
    auth.config.oauthProviders.unlinked = unlinked;
  });
  afterEach(() => {
    delete auth.config.oauthProviders.unlinked;
  });

  test("an existing user's email is refused with account_exists, and nothing is linked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    knownUsers["ada@example.com"] = { id: 1, email: "ada@example.com" };
    const link = vi.spyOn(auth.userProvider, "createSocialAccount");
    profile = { providerId: "p1", email: "Ada@Example.com" };

    const { state, cookie } = await start("unlinked");
    const { result, cookies } = await finish(`?code=c&state=${state}`, cookie, "unlinked");

    expect(result.error).toBe("account_exists");
    expect(result.session).toBeNull();
    expect(link).not.toHaveBeenCalled();
    expect(seen.created).toEqual([]);
    expect(cookieValue(cookies, "access_token")).toBeUndefined();
  });

  test("a new email still creates a user, with the identity linked", async () => {
    const link = vi.spyOn(auth.userProvider, "createSocialAccount");
    profile = { providerId: "p1", email: "grace@example.com", username: "grace" };

    const { state, cookie } = await start("unlinked");
    const { result } = await finish(`?code=c&state=${state}`, cookie, "unlinked");

    expect(result.session.user.id).toBe(99);
    expect(seen.created).toMatchObject([{ email: "grace@example.com" }]);
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "unlinked", providerId: "p1", userId: 99 }),
    );
  });

  test("an identity already linked signs in whatever the email", async () => {
    knownUsers["ada@example.com"] = { id: 1, email: "ada@example.com" };
    vi.spyOn(auth.userProvider, "findUserBySocialAccount").mockResolvedValue({
      id: 1,
      email: "ada@example.com",
    } as never);
    profile = { providerId: "p1", email: "ada@example.com" };

    const { state, cookie } = await start("unlinked");
    const { result } = await finish(`?code=c&state=${state}`, cookie, "unlinked");

    expect(result.session.user.id).toBe(1);
    expect(seen.lookups).toEqual([]);
  });
});

describe("a failed callback", () => {
  test("?error= short-circuits with the provider's reason and the return path", async () => {
    const { cookie } = await start("scripted", "http://localhost", "?redirect=%2Finvoices");
    const intended = `intended_url=${encodeURIComponent("/invoices")}`;

    const { result, cookies } = await finish(
      "?error=access_denied&state=whatever",
      `${cookie}; ${intended}`,
    );

    expect(result).toEqual({ session: null, error: "access_denied", redirectTo: "/invoices" });
    expect(seen.callback).toEqual([]);
    // Both round-trip cookies are cleared.
    expect(cookies).toContainEqual(expect.stringMatching(/^gemi_oauth=; Max-Age=-1/));
    expect(cookies).toContainEqual(expect.stringMatching(/^intended_url=; Max-Age=-1/));
  });

  test("a provider error that is not a plain code is reported as provider_error", async () => {
    const { result } = await finish("?error=%3Cscript%3E", "");
    expect(result.error).toBe("provider_error");
  });

  test("an OAuthCallbackError's code reaches the app; any other error is provider_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    callbackError = new OAuthCallbackError("invalid_grant");
    let round = await start();
    expect((await finish(`?code=c&state=${round.state}`, round.cookie)).result.error).toBe(
      "invalid_grant",
    );

    callbackError = new Error("boom");
    round = await start();
    expect((await finish(`?code=c&state=${round.state}`, round.cookie)).result.error).toBe(
      "provider_error",
    );
  });

  test("no identity at all is no_identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    profile = {};
    const { state, cookie } = await start();
    expect((await finish(`?code=c&state=${state}`, cookie)).result.error).toBe("no_identity");
  });

  test("with oauthFailurePath, redirects there with ?error= and ?redirect=", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.config.oauthFailurePath = "/auth/sign-in";
    const intended = `intended_url=${encodeURIComponent("/invoices?page=2")}`;

    const { location, cookies } = await finish("?code=c&state=s", intended);

    const url = new URL(location!, "http://localhost");
    expect(url.pathname).toBe("/auth/sign-in");
    expect(url.searchParams.get("error")).toBe("missing_state");
    expect(url.searchParams.get("redirect")).toBe("/invoices?page=2");
    expect(cookies).toContainEqual(expect.stringMatching(/^intended_url=; Max-Age=-1/));
  });

  test("an off-origin oauthFailurePath is not followed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.config.oauthFailurePath = "https://evil.example/x";
    const { location, result } = await finish("?error=access_denied", "");
    expect(location).toBeNull();
    expect(result.error).toBe("access_denied");
  });
});

describe("GoogleOAuthProvider", () => {
  function stubGoogle(userinfo: Record<string, unknown>, token: any = { access_token: "at" }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, init });
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return Response.json(token, { status: token.access_token ? 200 : 400 });
        }
        if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
          return Response.json(userinfo);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    return calls;
  }

  const req = () =>
    new HttpRequest(
      new Request("http://localhost/auth/oauth/google/callback?code=the-code"),
      { provider: "google" },
      "view",
    );

  test("the authorization URL carries the state, the challenge and redirectPath", () => {
    const google = new GoogleOAuthProvider({
      clientId: "id",
      redirectPath: "/sso/google/done",
      authorizationParams: { prompt: "select_account", state: "ignored" },
    });
    const url = new URL(
      google.getRedirectUrl(undefined, {
        state: "the-state",
        codeChallenge: "the-challenge",
        codeChallengeMethod: "S256",
      }),
    );

    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/sso/google/done");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.getAll("state")).toEqual(["the-state"]);
  });

  test("the token exchange sends the verifier and the same redirect_uri, in the body", async () => {
    const calls = stubGoogle({ sub: "g-1", email: "ada@x.test", email_verified: true });
    const google = new GoogleOAuthProvider({
      clientId: "id",
      clientSecret: "secret",
      redirectPath: "/sso/google/done",
    });

    const result = await google.onCallback(req(), { state: "s", codeVerifier: "the-verifier" });

    expect(result).toEqual({
      providerId: "g-1",
      name: undefined,
      email: "ada@x.test",
      emailVerified: true,
    });
    const token = calls[0];
    expect(new URL(token.url).search).toBe("");
    const body = new URLSearchParams(String(token.init!.body));
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe("https://app.example/sso/google/done");
    expect(body.get("client_secret")).toBe("secret");
    // The access token goes in a header, not the URL.
    expect(calls[1].url).not.toContain("at");
    expect(new Headers(calls[1].init!.headers).get("Authorization")).toBe("Bearer at");
  });

  test.each([
    ["false", false],
    ["missing", undefined],
    ["the string 'false'", "false"],
  ])("email_verified %s is reported as unverified", async (_, value) => {
    stubGoogle({ sub: "g-1", email: "ada@x.test", email_verified: value });
    const google = new GoogleOAuthProvider({ clientId: "id" });
    const result = await google.onCallback(req(), { state: "s", codeVerifier: "v" });
    expect(result.emailVerified).toBe(false);
  });

  test("a failed token exchange throws its error code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGoogle({}, { error: "invalid_grant" });
    const google = new GoogleOAuthProvider({ clientId: "id" });
    await expect(google.onCallback(req(), { state: "s", codeVerifier: "v" })).rejects.toMatchObject(
      { name: "OAuthCallbackError", code: "invalid_grant" },
    );
  });
});

describe("XOAuthProvider", () => {
  test("the authorization URL carries gemi's state and challenge", () => {
    const x = new XOAuthProvider({ clientId: "id", clientSecret: "secret" });
    const url = new URL(
      x.getRedirectUrl(undefined, {
        state: "the-state",
        codeChallenge: "the-challenge",
        codeChallengeMethod: "S256",
      }),
    );
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/auth/oauth/x/callback");
  });

  test("the token exchange uses the verifier from the cookie", async () => {
    const x = new XOAuthProvider({ clientId: "id", clientSecret: "secret" });
    const login = vi.spyOn(x.client, "loginWithOAuth2").mockResolvedValue({
      client: { v2: { me: async () => ({ data: { id: "x-1", name: "Ada", username: "ada" } }) } },
    } as any);

    const result = await x.onCallback(
      new HttpRequest(new Request("http://localhost/auth/oauth/x/callback?code=k"), {}, "view"),
      { state: "s", codeVerifier: "the-verifier" },
    );

    expect(login).toHaveBeenCalledWith({
      code: "k",
      codeVerifier: "the-verifier",
      redirectUri: "https://app.example/auth/oauth/x/callback",
    });
    expect(result).toMatchObject({ providerId: "x-1", username: "ada" });
  });
});
