import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../../http/HttpRequest";
import { RequestContext } from "../../http/requestContext";
import type { OAuthTokenSet } from "./OAuthConnectionProvider";

/**
 * `/auth/connections/:provider` and its callback (#845): the same `state` +
 * PKCE round trip as a sign-in, in its own cookie, bound to the signed-in
 * user, stored through the manager, and back to where it started.
 */

const exchanged: { code: string; codeVerifier: string; redirectUri: string }[] = [];
let exchangeResult: () => Promise<OAuthTokenSet>;
const saved: { userId: unknown; provider: string; tokens: OAuthTokenSet }[] = [];
const connected: { provider: string; profile?: unknown }[] = [];

const figma = {
  config: { redirectUri: undefined as string | undefined },
  authorizationUrl: (args: { state: string; codeChallenge: string; redirectUri: string }) => {
    const url = new URL("https://provider.example/oauth");
    url.searchParams.set("state", args.state);
    url.searchParams.set("code_challenge", args.codeChallenge);
    url.searchParams.set("redirect_uri", args.redirectUri);
    return url.toString();
  },
  exchangeCode: async (args: { code: string; codeVerifier: string; redirectUri: string }) => {
    exchanged.push(args);
    return exchangeResult();
  },
};

const manager = {
  providers: { figma } as Record<string, typeof figma>,
  save: async (user: { id: unknown }, provider: string, tokens: OAuthTokenSet) => {
    saved.push({ userId: user.id, provider, tokens });
    return { provider };
  },
};
const authManager = {
  config: {
    redirectPath: "/dashboard",
    onConnected: async (args: { provider: string; profile: unknown }) => {
      connected.push(args.profile === null ? { provider: args.provider } : { provider: args.provider, profile: args.profile });
    },
  },
};

vi.mock("../../foundation/app", () => ({
  app: (token: { name?: string }) => (token?.name === "ConnectionManager" ? manager : authManager),
}));

const { ConnectionsController } = await import("./ConnectionsController");
const { clearConsumedOAuthStates, openOAuthState } = await import("../oauth/oauthState");
const { OAuthConnectionError } = await import("./errors");

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
  exchanged.length = 0;
  saved.length = 0;
  connected.length = 0;
  exchangeResult = async () => ({
    accessToken: "at",
    refreshToken: "rt",
    tokenType: "bearer",
    expiresAt: null,
    scopes: ["files:read"],
    providerAccountId: "acct",
  });
  clearConsumedOAuthStates();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ada = { id: 7, email: "ada@example.com" };
const bob = { id: 8, email: "bob@example.com" };

async function inRequest(url: string, cookie: string, user: object, fn: () => Promise<unknown>) {
  const req = new HttpRequest(new Request(url, { headers: { Cookie: cookie } }), { provider: "figma" }, "view");
  return RequestContext.run(req, async () => {
    RequestContext.getStore().setUser(user as any);
    let location: string | null = null;
    try {
      await fn();
    } catch (error: any) {
      if (error?.name !== "RedirectError") throw error;
      location = error.payload.view.headers.Location;
    }
    return { location, cookies: [...RequestContext.getStore().cookies].map(String) };
  });
}

function cookieValue(cookies: string[], name: string) {
  const line = cookies.find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : undefined;
}

async function connect(query = "", user: object = ada, origin = "http://localhost") {
  const { location, cookies } = await inRequest(`${origin}/auth/connections/figma${query}`, "", user, () =>
    new ConnectionsController().connect(),
  );
  const name = origin.startsWith("https") ? "__Host-gemi_oauth_connection" : "gemi_oauth_connection";
  const destination = new URL(location!);
  return { destination, cookie: `${name}=${cookieValue(cookies, name)}`, cookies, state: destination.searchParams.get("state")! };
}

function callback(query: string, cookie: string, user: object = ada, origin = "http://localhost") {
  return inRequest(`${origin}/auth/connections/figma/callback${query}`, cookie, user, () =>
    new ConnectionsController().callback(),
  );
}

describe("connect", () => {
  test("redirects to the provider with a state bound to the user, in a cookie of its own", async () => {
    const { destination, cookies, cookie } = await connect("?redirect=/settings/integrations");
    expect(destination.origin).toBe("https://provider.example");
    expect(destination.searchParams.get("redirect_uri")).toBe("https://app.example/auth/connections/figma/callback");

    const line = cookies.find((c) => c.startsWith("gemi_oauth_connection="))!;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    const payload = openOAuthState(cookie.split("=")[1])!;
    expect(payload).toMatchObject({ provider: "connection:figma", subject: "7", returnTo: "/settings/integrations" });
    // The sign-in cookie is left alone.
    expect(cookies.some((c) => c.startsWith("gemi_oauth="))).toBe(false);
  });

  test("on https the cookie is __Host- prefixed", async () => {
    const { cookies } = await connect("", ada, "https://app.example");
    expect(cookies.find((c) => c.startsWith("__Host-gemi_oauth_connection="))).toContain("Secure");
  });

  test("an off-site ?redirect= is dropped", async () => {
    const { cookie } = await connect("?redirect=https://evil.example/");
    expect(openOAuthState(cookie.split("=")[1])!.returnTo).toBeUndefined();
  });

  test("an unknown provider goes back with connection_error", async () => {
    const { location } = await inRequest("http://localhost/auth/connections/nope", "", ada, () => {
      const req = new HttpRequest(new Request("http://localhost/auth/connections/nope"), { provider: "nope" }, "view");
      return new ConnectionsController().connect(req);
    });
    expect(location).toBe("/dashboard?connection=nope&connection_error=unknown_provider");
  });
});

describe("callback", () => {
  test("exchanges the code with the PKCE verifier, stores the connection and returns", async () => {
    const { state, cookie } = await connect("?redirect=/settings");
    const { location, cookies } = await callback(`?code=the-code&state=${state}`, cookie);

    expect(location).toBe("/settings?connection=figma");
    const verifier = openOAuthState(cookie.split("=")[1])!.codeVerifier;
    expect(exchanged).toEqual([
      { code: "the-code", codeVerifier: verifier, redirectUri: "https://app.example/auth/connections/figma/callback" },
    ]);
    expect(saved).toMatchObject([{ userId: 7, provider: "figma", tokens: { accessToken: "at" } }]);
    expect(connected).toEqual([{ provider: "figma" }]);
    // Single use: the cookie is deleted.
    expect(cookies).toContainEqual(expect.stringMatching(/^gemi_oauth_connection=; Max-Age=-1/));
  });

  test("hands onConnected the profile the exchange reported", async () => {
    const base = await exchangeResult();
    exchangeResult = async () => ({ ...base, profile: { username: "acme" } });
    const { state, cookie } = await connect();
    await callback(`?code=c&state=${state}`, cookie);
    expect(connected).toEqual([{ provider: "figma", profile: { username: "acme" } }]);
  });

  test("a callback finished by another signed-in user is refused", async () => {
    const { state, cookie } = await connect();
    const { location } = await callback(`?code=c&state=${state}`, cookie, bob);
    expect(location).toBe("/dashboard?connection=figma&connection_error=user_mismatch");
    expect(exchanged).toEqual([]);
    expect(saved).toEqual([]);
  });

  test("a missing or forged state is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await connect();
    expect((await callback(`?code=c&state=${state}`, "")).location).toBe(
      "/dashboard?connection=figma&connection_error=missing_state",
    );
    expect((await callback(`?code=c&state=forged`, cookie)).location).toMatch(/connection_error=invalid_state/);
    expect(exchanged).toEqual([]);
  });

  test("a state is single use", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, cookie } = await connect();
    await callback(`?code=c&state=${state}`, cookie);
    const replay = await callback(`?code=c&state=${state}`, cookie);
    expect(replay.location).toMatch(/connection_error=/);
    expect(exchanged).toHaveLength(1);
  });

  test("a sign-in's state cannot complete a connection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createOAuthState } = await import("../oauth/oauthState");
    const signIn = createOAuthState("figma");
    const { location } = await callback(`?code=c&state=${signIn.state}`, `gemi_oauth_connection=${signIn.cookieValue}`);
    expect(location).toMatch(/connection_error=/);
    expect(exchanged).toEqual([]);
  });

  test("the provider's error comes back as connection_error", async () => {
    const { state, cookie } = await connect();
    expect((await callback(`?error=access_denied&state=${state}`, cookie)).location).toBe(
      "/dashboard?connection=figma&connection_error=access_denied",
    );
    const other = await connect();
    expect((await callback(`?error=%3Cscript%3E&state=${other.state}`, other.cookie)).location).toMatch(
      /connection_error=provider_error$/,
    );
  });

  test("a refused code exchange comes back as connection_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    exchangeResult = async () => {
      throw new OAuthConnectionError("exchange_failed", "no", { status: 400, providerError: "invalid_grant" });
    };
    const { state, cookie } = await connect();
    expect((await callback(`?code=c&state=${state}`, cookie)).location).toBe(
      "/dashboard?connection=figma&connection_error=invalid_grant",
    );
    expect(saved).toEqual([]);
  });

  test("a callback without a code is refused", async () => {
    const { state, cookie } = await connect();
    expect((await callback(`?state=${state}`, cookie)).location).toMatch(/connection_error=missing_code/);
  });
});
