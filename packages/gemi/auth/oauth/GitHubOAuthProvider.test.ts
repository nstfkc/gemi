import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { HttpRequest } from "../../http/HttpRequest";

vi.mock("../../foundation/app", () => ({ app: () => ({}) }));

const { GitHubOAuthProvider } = await import("./GitHubOAuthProvider");

/** `GitHubOAuthProvider` (#1141), against stubbed GitHub endpoints. */

const previousHost = process.env.HOST_NAME;
beforeAll(() => {
  process.env.HOST_NAME = "https://app.example";
});
afterAll(() => {
  process.env.HOST_NAME = previousHost;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Call = { url: string; init?: RequestInit };

function stubGitHub(
  opts: {
    token?: Record<string, unknown>;
    tokenStatus?: number;
    user?: Record<string, unknown>;
    userStatus?: number;
    emails?: unknown;
    emailsStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json(opts.token ?? { access_token: "gho_token", token_type: "bearer" }, {
          status: opts.tokenStatus ?? 200,
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json(
          opts.user ?? { id: 583231, login: "octocat", name: "The Octocat", email: null },
          { status: opts.userStatus ?? 200 },
        );
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json(
          opts.emails ?? [
            { email: "other@example.com", primary: false, verified: true },
            { email: "Octo@Example.com", primary: true, verified: true },
          ],
          { status: opts.emailsStatus ?? 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return calls;
}

const callback = (url = "https://app.example/auth/oauth/github/callback?code=the-code") =>
  new HttpRequest(new Request(url), { provider: "github" }, "view");

const ctx = { state: "the-state", codeChallenge: "the-challenge", codeChallengeMethod: "S256" as const };

describe("the authorization URL", () => {
  test("carries the state, the challenge, the scope and HOST_NAME + redirectPath", () => {
    const github = new GitHubOAuthProvider({
      clientId: "id",
      authorizationParams: { allow_signup: "false", state: "ignored", client_id: "ignored" },
    });
    const url = new URL(github.getRedirectUrl(undefined, ctx) as string);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("id");
    expect(url.searchParams.getAll("state")).toEqual(["the-state"]);
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/auth/oauth/github/callback",
    );
    expect(url.searchParams.get("allow_signup")).toBe("false");
  });

  test("defaults to GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "env-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "env-secret");
    try {
      const github = new GitHubOAuthProvider();
      expect(github.config.clientId).toBe("env-id");
      expect(github.config.clientSecret).toBe("env-secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the callback", () => {
  test("exchanges the code as JSON, with the verifier and the secret in the body", async () => {
    const calls = stubGitHub();
    const github = new GitHubOAuthProvider({ clientId: "id", clientSecret: "secret" });
    await github.onCallback(callback(), { state: "s", codeVerifier: "the-verifier" });

    const exchange = calls[0];
    expect(exchange.init?.method).toBe("POST");
    expect(new Headers(exchange.init?.headers).get("Accept")).toBe("application/json");
    const body = new URLSearchParams(String(exchange.init?.body));
    expect(body.get("client_id")).toBe("id");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe("https://app.example/auth/oauth/github/callback");

    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer gho_token");
      expect(headers.get("User-Agent")).toBeTruthy();
      expect(call.url).not.toContain("gho_token");
    }
  });

  test("returns the numeric id, the login, and the primary verified email", async () => {
    stubGitHub();
    const github = new GitHubOAuthProvider({ clientId: "id" });
    const profile = await github.onCallback(callback(), { state: "s", codeVerifier: "v" });
    expect(profile).toEqual({
      providerId: "583231",
      username: "octocat",
      name: "The Octocat",
      email: "Octo@Example.com",
      emailVerified: true,
    });
  });

  test("a private profile email is found through /user/emails", async () => {
    stubGitHub({ user: { id: 7, login: "ada", name: null, email: null } });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    const profile = await github.onCallback(callback(), { state: "s", codeVerifier: "v" });
    expect(profile.email).toBe("Octo@Example.com");
    expect(profile.emailVerified).toBe(true);
    // No name: the login stands in.
    expect(profile.name).toBe("ada");
  });

  test("an unverified primary address is not reported as verified", async () => {
    stubGitHub({
      user: { id: 7, login: "ada", email: "public@example.com" },
      emails: [{ email: "primary@example.com", primary: true, verified: false }],
    });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    const profile = await github.onCallback(callback(), { state: "s", codeVerifier: "v" });
    expect(profile.email).toBe("public@example.com");
    expect(profile.emailVerified).toBe(false);
  });

  test("without the emails scope, the public email comes back unverified", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGitHub({
      user: { id: 7, login: "ada", email: "public@example.com" },
      emails: { message: "Not Found" },
      emailsStatus: 404,
    });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    const profile = await github.onCallback(callback(), { state: "s", codeVerifier: "v" });
    expect(profile).toMatchObject({ providerId: "7", email: "public@example.com", emailVerified: false });
  });

  test("no address at all: no email", async () => {
    stubGitHub({ user: { id: 7, login: "ada", email: null }, emails: [] });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    const profile = await github.onCallback(callback(), { state: "s", codeVerifier: "v" });
    expect(profile.email).toBeUndefined();
    expect(profile.emailVerified).toBeUndefined();
    expect(profile.providerId).toBe("7");
  });

  test("a bad code (a 200 with an error) throws its code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGitHub({ token: { error: "bad_verification_code", error_description: "expired" } });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    await expect(github.onCallback(callback(), { state: "s", codeVerifier: "v" })).rejects.toMatchObject({
      name: "OAuthCallbackError",
      code: "bad_verification_code",
    });
  });

  test("an odd error is reported as exchange_failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGitHub({ token: { error: "<script>" }, tokenStatus: 500 });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    await expect(github.onCallback(callback(), { state: "s", codeVerifier: "v" })).rejects.toMatchObject({
      code: "exchange_failed",
    });
  });

  test("a /user response without a numeric id is no identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubGitHub({ user: { message: "Bad credentials" }, userStatus: 401 });
    const github = new GitHubOAuthProvider({ clientId: "id" });
    expect(await github.onCallback(callback(), { state: "s", codeVerifier: "v" })).toEqual({});
  });

  test("no code: missing_code", async () => {
    const github = new GitHubOAuthProvider({ clientId: "id" });
    await expect(
      github.onCallback(callback("https://app.example/auth/oauth/github/callback"), {
        state: "s",
        codeVerifier: "v",
      }),
    ).rejects.toMatchObject({ code: "missing_code" });
  });
});

describe("with resolve (#1140)", () => {
  const resolve = ({ origin }: { origin: string }) =>
    new URL(origin).host === "a.example"
      ? { clientId: "client-a", clientSecret: "secret-a", origin }
      : null;

  test("the authorization and the exchange use the host's client and callback", async () => {
    const github = new GitHubOAuthProvider({ resolve });
    const req = callback("https://a.example/auth/oauth/github/callback?code=the-code");
    const url = new URL(await github.getRedirectUrl(req, ctx));
    expect(url.searchParams.get("client_id")).toBe("client-a");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://a.example/auth/oauth/github/callback",
    );

    const calls = stubGitHub();
    await github.onCallback(req, { state: "s", codeVerifier: "v" });
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("client_id")).toBe("client-a");
    expect(body.get("client_secret")).toBe("secret-a");
    expect(body.get("redirect_uri")).toBe("https://a.example/auth/oauth/github/callback");
  });

  test("null: not offered on the request", async () => {
    const github = new GitHubOAuthProvider({ resolve });
    const req = callback("https://b.example/auth/oauth/github/callback?code=c");
    expect(await github.isAvailable(req)).toBe(false);
    expect(await github.isAvailable(callback())).toBe(false);
    expect(await github.isAvailable(callback("https://a.example/"))).toBe(true);
    await expect(github.onCallback(req, { state: "s", codeVerifier: "v" })).rejects.toMatchObject({
      code: "unknown_provider",
    });
  });
});
