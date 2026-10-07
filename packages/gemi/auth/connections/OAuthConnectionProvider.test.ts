import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { OAuthConnectionError } from "./errors";
import { OAuthConnectionProvider } from "./OAuthConnectionProvider";

/**
 * The provider half of OAuth connections (#845): the authorization URL, and
 * the code exchange, refresh and revocation against a token endpoint served
 * on loopback.
 */

type Seen = { path: string; form: Record<string, string>; headers: Headers };
let seen: Seen[] = [];
let answer: (path: string, form: Record<string, string>) => Response = () => Response.json({});
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      seen.push({ path: url.pathname, form, headers: req.headers });
      return answer(url.pathname, form);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  answer = () => Response.json({});
});

function provider(overrides: Partial<ConstructorParameters<typeof OAuthConnectionProvider>[0]> = {}) {
  return new OAuthConnectionProvider({
    authorizeUrl: "https://provider.example/oauth",
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    clientId: "client id",
    clientSecret: "s3cret:",
    scopes: ["files:read", "files:write"],
    apiBaseUrl: "https://api.provider.example",
    ...overrides,
  });
}

describe("OAuthConnectionProvider", () => {
  test("refuses endpoints that are not https (http only on loopback)", () => {
    expect(() => provider({ tokenUrl: "http://provider.example/token" })).toThrow(/https/);
    expect(() => provider({ apiBaseUrl: "ftp://provider.example" })).toThrow(/https/);
    expect(() => provider({ revokeUrl: "nope" })).toThrow(/https/);
    expect(() => provider({ tokenUrl: "http://localhost:9/token" })).not.toThrow();
  });

  test("requires apiBaseUrl, so the token only ever goes to the provider's API host", () => {
    for (const apiBaseUrl of [undefined, null, ""]) {
      expect(() => provider({ apiBaseUrl: apiBaseUrl as any })).toThrow(/apiBaseUrl is required/);
    }
    const { apiBaseUrl: _omitted, ...rest } = provider().config;
    // @ts-expect-error apiBaseUrl is required by the type too.
    expect(() => new OAuthConnectionProvider({ ...rest })).toThrow(/apiBaseUrl is required/);
  });

  test("builds the authorization URL with state, PKCE and the scopes", () => {
    const url = new URL(
      provider({ authorizationParams: { access_type: "offline", state: "ignored" } }).authorizationUrl({
        state: "st",
        codeChallenge: "ch",
        redirectUri: "https://app.example/auth/connections/figma/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://provider.example/oauth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_type: "offline",
      response_type: "code",
      client_id: "client id",
      redirect_uri: "https://app.example/auth/connections/figma/callback",
      scope: "files:read files:write",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });

  test("joins scopes with the configured separator and can leave PKCE out", () => {
    const url = new URL(
      provider({ scopeSeparator: ",", pkce: false }).authorizationUrl({ state: "s", codeChallenge: "c", redirectUri: "https://a.example/cb" }),
    );
    expect(url.searchParams.get("scope")).toBe("files:read,files:write");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  test("takes Figma's user_id_string over its rounded numeric user_id", async () => {
    // Parsed from `"user_id": 1234567890123456789`, the number is already off.
    answer = () =>
      new Response(
        '{"access_token":"at","user_id":1234567890123456789,"user_id_string":"1234567890123456789"}',
        { headers: { "content-type": "application/json" } },
      );
    const tokens = await provider().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://a.example/cb" });
    expect(tokens.providerAccountId).toBe("1234567890123456789");
  });

  test("exchanges a code: client credentials in the body, the verifier, JSON accepted", async () => {
    answer = () =>
      Response.json({
        access_token: "at",
        refresh_token: "rt",
        token_type: "bearer",
        expires_in: 3600,
        scope: "files:read",
        user_id: 42,
      });
    const before = Date.now();
    const tokens = await provider().exchangeCode({ code: "the-code", codeVerifier: "verifier", redirectUri: "https://a.example/cb" });

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/token");
    expect(seen[0].headers.get("accept")).toBe("application/json");
    expect(seen[0].headers.get("authorization")).toBeNull();
    expect(seen[0].form).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://a.example/cb",
      code_verifier: "verifier",
      client_id: "client id",
      client_secret: "s3cret:",
    });
    expect(tokens).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "bearer",
      scopes: ["files:read"],
      providerAccountId: "42",
    });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
  });

  test("sends HTTP Basic credentials with clientAuth: basic", async () => {
    answer = () => Response.json({ access_token: "at" });
    const tokens = await provider({ clientAuth: "basic" }).exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://a.example/cb" });
    const basic = seen[0].headers.get("authorization")!;
    expect(Buffer.from(basic.replace("Basic ", ""), "base64").toString()).toBe("client%20id:s3cret%3A");
    expect(seen[0].form.client_secret).toBeUndefined();
    // No scope in the answer: the ones requested. No expiry: unknown.
    expect(tokens.scopes).toEqual(["files:read", "files:write"]);
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.refreshToken).toBeNull();
  });

  test("a refresh keeps the old refresh token when the provider does not rotate it", async () => {
    answer = () => Response.json({ access_token: "at-2", expires_in: 60 });
    const tokens = await provider().refresh("rt-1", ["files:read"]);
    expect(seen[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1" });
    expect(tokens).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1", scopes: ["files:read"] });

    answer = () => Response.json({ access_token: "at-3", refresh_token: "rt-2" });
    expect((await provider().refresh("rt-1", [])).refreshToken).toBe("rt-2");
  });

  test("a refusal carries the status and the error code, never the body", async () => {
    answer = () => Response.json({ error: "invalid_grant", error_description: "token rt-secret is revoked" }, { status: 400 });
    const error = await provider()
      .refresh("rt-secret", [])
      .catch((e) => e);
    expect(error).toBeInstanceOf(OAuthConnectionError);
    expect(error).toMatchObject({ code: "refresh_failed", status: 400, providerError: "invalid_grant" });
    expect(error.message).not.toContain("rt-secret");

    answer = () => Response.json({ error: "<script>" }, { status: 401 });
    const odd = await provider()
      .exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://a.example/cb" })
      .catch((e) => e);
    expect(odd).toMatchObject({ code: "exchange_failed", status: 401, providerError: undefined });

    // A 200 without an access token is a failure too.
    answer = () => new Response("not json");
    await expect(provider().refresh("rt", [])).rejects.toMatchObject({ code: "refresh_failed", status: 200 });
  });

  test("a network failure is a failure without a status", async () => {
    const error = await provider({ tokenUrl: "http://127.0.0.1:1/token" })
      .refresh("rt", [])
      .catch((e) => e);
    expect(error).toMatchObject({ code: "refresh_failed", status: undefined });
  });

  test("revokes a token (RFC 7009)", async () => {
    answer = () => new Response(null, { status: 200 });
    await provider().revoke("rt", "refresh_token");
    expect(seen[0]).toMatchObject({ path: "/revoke", form: { token: "rt", token_type_hint: "refresh_token", client_id: "client id" } });

    answer = () => new Response(null, { status: 503 });
    await expect(provider().revoke("rt", "refresh_token")).rejects.toMatchObject({ code: "revoke_failed", status: 503 });
    await expect(provider({ revokeUrl: undefined }).revoke("rt", "refresh_token")).rejects.toMatchObject({
      code: "revoke_unsupported",
    });
  });
});
