import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

process.env.SECRET ??= "mcp-oauth-test-secret";

import { App } from "../../../../app/App";
import { AuthManager } from "../../../../auth/AuthManager";
import { UserProvider } from "../../../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../../../auth/types";
import { createRoot } from "../../../../client/createRoot";
import { ApiRouter, type CreateRPC } from "../../../../http/ApiRouter";
import { AuthenticationMiddleware } from "../../../../http/AuthenticationMiddlware";
import { HttpRequest } from "../../../../http/HttpRequest";
import { McpRouter } from "../../../../http/McpRouter";
import { ViewRouter } from "../../../../http/ViewRouter";
import { Kernel } from "../../../../kernel";
import { ServiceProvider } from "../../../../support/ServiceProvider";
import { McpApiKeyResolver } from "../callers";
import { McpOAuthServer } from "./McpOAuthServer";
import { MemoryMcpOAuthStore } from "./store";

/**
 * The OAuth authorization server end to end, through `App.fetch`: a client
 * registers, sends the user to authorize, the user consents on a page bound
 * to them, the client redeems the code with PKCE, and its token reaches the
 * MCP endpoint as that user — and every way that can be abused is refused.
 */

const ALICE = { id: 1, name: "alice", email: "alice@shop.test" };
const BOB = { id: 2, name: "bob", email: "bob@shop.test" };
const USERS = new Map<string, any>([
  ["1", ALICE],
  ["2", BOB],
]);
const SESSIONS: Record<string, any> = { "v2.tok-alice": ALICE, "v2.tok-bob": BOB };
const LIVE = {
  expiresAt: new Date(Date.now() + 365 * 86_400_000),
  absoluteExpiresAt: new Date(Date.now() + 365 * 86_400_000),
};

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const user = SESSIONS[args.token];
    return user ? ({ token: args.token, ...LIVE, user } as any) : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

class Api extends ApiRouter {
  routes = {
    "/me": this.get(async () => {
      const req = new HttpRequest<any, any>();
      return { id: req.ctx().user?.id ?? null, grant: req.mcpGrant() };
    }).middleware(["auth"]),
    "/pages/:id": this.delete(async () => ({ deleted: true })).middleware(["auth"]),
  };
}

class Mcp extends McpRouter<CreateRPC<Api>> {
  scopes = {
    "site:read": { description: "Read your site", tags: ["read"] },
    "site:write": { description: "Edit your site", tags: ["write"] },
  };
  routes = {
    whoami: this.fromApiRoute("GET", "/me", { description: "Who the user is", tags: ["read"] }),
    "delete-page": this.fromApiRoute("DELETE", "/pages/:id", {
      description: "Delete a page",
      params: { id: "input" },
      tags: ["write"],
    }),
  };
}

let store = new MemoryMcpOAuthStore();
const oauth = (options: Partial<ConstructorParameters<typeof McpOAuthServer>[0]> = {}) =>
  new McpOAuthServer({
    store: {
      createClient: (c) => store.createClient(c),
      findClient: (id) => store.findClient(id),
      saveCode: (c) => store.saveCode(c),
      findCode: (h) => store.findCode(h),
      saveToken: (t) => store.saveToken(t),
      findToken: (h) => store.findToken(h),
      use: (h, e) => store.use(h, e),
      revokeFamily: (f) => store.revokeFamily(f),
    },
    findUser: async (id) => USERS.get(id) ?? null,
    appName: "Shop",
    ...options,
  });

function appWith(server: McpOAuthServer) {
  class AppKernel extends Kernel {
    protected providers = [StubAuthProvider];
    config = {
      middleware: { aliases: { auth: AuthenticationMiddleware } },
      route: {
        api: { rootRouter: Api },
        view: { root: createRoot(() => createElement("div")), rootRouter: class extends ViewRouter {} },
        mcp: {
          router: Mcp,
          remote: {
            enabled: true,
            url: "https://shop.test/mcp",
            resolvers: [
              new McpApiKeyResolver({
                prefix: "tk_mcp_",
                verify: async (key) => (key === "tk_mcp_alice" ? { user: ALICE as any, id: "key_a", scopes: ["site:read"] } : null),
              }),
              server,
            ],
          },
        },
      },
    };
  }
  return new App({ kernel: AppKernel });
}

const server = oauth();
const app = appWith(server);

const CLAUDE = "https://claude.example/api/mcp/auth_callback";
let ip = 0;

function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, target = app) {
  return target.fetch(
    new Request(`https://shop.test${path}`, {
      ...init,
      headers: { "x-forwarded-for": `10.0.0.${ip}`, ...init.headers },
    }),
  );
}

async function register(metadata: Record<string, unknown> = {}, target = app) {
  const res = await call(
    "/mcp/oauth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CLAUDE],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        client_name: "Claude",
        ...metadata,
      }),
    },
    target,
  );
  return { res, body: (await res.json()) as any };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
  return `/mcp/oauth/authorize?${query}`;
}

async function authorize(clientId: string, overrides: Record<string, string | undefined> = {}, target = app) {
  const { verifier, challenge } = pkce();
  const res = await call(
    authorizeUrl({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-123",
      resource: "https://shop.test/mcp",
      scope: "site:read site:write",
      ...overrides,
    }),
    {},
    target,
  );
  return { res, verifier, location: res.headers.get("location") };
}

/** The consent page for the ticket in `location`, as the user with `session` sees it. */
async function consentPage(location: string, session = "v2.tok-alice") {
  const url = new URL(location);
  const res = await call(`${url.pathname}${url.search}`, { headers: { Cookie: `access_token=${session}` } });
  const html = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;
  return { res, html, request: field("request"), csrf: field("csrf") };
}

function decide(
  fields: Record<string, string | null>,
  options: { session?: string | null; origin?: string | null; fetchSite?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const session = options.session === undefined ? "v2.tok-alice" : options.session;
  if (session) headers.Cookie = `access_token=${session}`;
  const origin = options.origin === undefined ? "https://shop.test" : options.origin;
  if (origin) headers.Origin = origin;
  if (options.fetchSite) headers["Sec-Fetch-Site"] = options.fetchSite;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== null) body.set(key, value);
  return call("/mcp/oauth/consent", { method: "POST", headers, body: body.toString() });
}

function tokenRequest(form: Record<string, string>, headers: Record<string, string> = {}) {
  return call("/mcp/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

/** Registration through consent: a code, and what redeeming it needs. */
async function codeFor(options: { scope?: string; session?: string; metadata?: Record<string, unknown> } = {}) {
  const { body: client } = await register(options.metadata);
  const { location, verifier } = await authorize(client.client_id, options.scope ? { scope: options.scope } : {});
  const page = await consentPage(location!, options.session);
  const res = await decide({ request: page.request, csrf: page.csrf, decision: "allow" }, { session: options.session });
  const back = new URL(res.headers.get("location")!);
  return { client, verifier, code: back.searchParams.get("code")!, back };
}

async function connect(options: Parameters<typeof codeFor>[0] = {}) {
  const { client, verifier, code } = await codeFor(options);
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CLAUDE,
    resource: "https://shop.test/mcp",
  });
  return { client, tokens: (await res.json()) as any, res };
}

let nextId = 1;
function mcp(token: string | null, method = "tools/list", params: Record<string, unknown> = {}) {
  return call("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

beforeEach(() => {
  store = new MemoryMcpOAuthStore();
  ip += 1;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discovery", () => {
  test("a request without a token is pointed at the resource metadata", async () => {
    const res = await mcp(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://shop.test/.well-known/oauth-protected-resource/mcp", scope="site:read site:write"',
    );
  });

  test("protected resource metadata, at the path-inserted and the root location", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({
        resource: "https://shop.test/mcp",
        authorization_servers: ["https://shop.test"],
        scopes_supported: ["site:read", "site:write"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  test("authorization server metadata", async () => {
    const metadata = await (await call("/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({
      issuer: "https://shop.test",
      authorization_endpoint: "https://shop.test/mcp/oauth/authorize",
      token_endpoint: "https://shop.test/mcp/oauth/token",
      registration_endpoint: "https://shop.test/mcp/oauth/register",
      revocation_endpoint: "https://shop.test/mcp/oauth/revoke",
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
    });
  });

  test("another host gets none of it", async () => {
    // Not answered by the endpoint: the app's own routing has it (a view, here).
    const res: unknown = await app.fetch(new Request("https://rebound.test/.well-known/oauth-authorization-server"));
    expect(res instanceof Response && /json/.test(res.headers.get("content-type") ?? "")).toBe(false);
  });

  test("the boot refuses a server without a store or findUser", () => {
    expect(() => new McpOAuthServer({ findUser: async () => null } as any)).toThrow(/store\.createClient is missing/);
    expect(() => new McpOAuthServer({ store, findUser: undefined } as any)).toThrow(/findUser/);
    expect(() => oauth({ consentPath: "https://evil.test/consent" })).toThrow(/consentPath/);
    expect(() => oauth({ accessTokenTtl: 5 })).toThrow(/accessTokenTtl/);
  });
});

describe("registration", () => {
  test("a public client gets an id and no secret", async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^gmcp_c_/);
    expect(body.client_secret).toBeUndefined();
    expect(body).toMatchObject({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "none", client_name: "Claude" });
  });

  test("a client that does not say gets client_secret_basic and a secret, stored hashed", async () => {
    const { body } = await register({ token_endpoint_auth_method: undefined });
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(body.client_secret).toMatch(/^gmcp_cs_/);
    const stored = await store.findClient(body.client_id);
    expect(stored!.clientSecretHash).toBe(createHash("sha256").update(body.client_secret).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(body.client_secret);
  });

  test("redirect URIs must be https or loopback http, without a fragment", async () => {
    for (const uri of [
      "http://claude.example/cb",
      "javascript:alert(1)",
      "https://claude.example/cb#x",
      "https://user:pw@claude.example/cb",
      "claude://cb",
      "/relative",
    ]) {
      const { res, body } = await register({ redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    }
    const loopback = await register({ redirect_uris: ["http://127.0.0.1:33418/callback", "http://localhost/cb"] });
    expect(loopback.res.status).toBe(201);
    const many = await register({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`) });
    expect(many.res.status).toBe(400);
  });

  test("an app can narrow the redirect URIs it accepts", async () => {
    const narrow = appWith(oauth({ registration: { allowRedirectUri: (uri) => uri.host === "claude.example" } }));
    expect((await register({}, narrow)).res.status).toBe(201);
    const other = await register({ redirect_uris: ["https://evil.example/cb"] }, narrow);
    expect(other.res.status).toBe(400);
  });

  test("bad metadata is refused", async () => {
    expect((await register({ grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");
    expect((await register({ response_types: ["token"] })).body.error).toBe("invalid_client_metadata");
    expect((await register({ token_endpoint_auth_method: "private_key_jwt" })).body.error).toBe("invalid_client_metadata");
    expect((await register({ client_name: "x".repeat(101) })).body.error).toBe("invalid_client_metadata");
    expect((await register({ client_uri: "http://claude.example" })).body.error).toBe("invalid_client_metadata");
    const notJson = await call("/mcp/oauth/register", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(notJson.status).toBe(400);
  });

  test("registrations are limited per address", async () => {
    for (let i = 0; i < 20; i++) expect((await register()).res.status).toBe(201);
    const limited = await register();
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("retry-after")).toBeTruthy();
  });

  test("registration can be turned off", async () => {
    const closed = appWith(oauth({ registration: false }));
    const res: unknown = await call(
      "/mcp/oauth/register",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CLAUDE] }) },
      closed,
    );
    expect(res instanceof Response && res.status === 201).toBe(false);
    const metadata = await (await call("/.well-known/oauth-authorization-server", {}, closed)).json();
    expect(metadata.registration_endpoint).toBeUndefined();
  });
});

describe("authorize", () => {
  test("an unknown client, or a redirect URI it did not register, is never redirected to", async () => {
    const { body: client } = await register();
    for (const res of [
      (await authorize("gmcp_c_nope")).res,
      (await authorize(client.client_id, { redirect_uri: "https://evil.example/cb" })).res,
      (await authorize(client.client_id, { redirect_uri: `${CLAUDE}/../evil` })).res,
      (await authorize(client.client_id, { redirect_uri: `${CLAUDE}?x=1` })).res,
    ]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
    }
  });

  test("other errors go back to the client, with state and iss", async () => {
    const { body: client } = await register();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.test/mcp" }, "invalid_target"],
      [{ scope: "openid admin" }, "invalid_scope"],
    ];
    for (const [overrides, error] of cases) {
      const { res, location } = await authorize(client.client_id, overrides);
      expect(res.status).toBe(302);
      const back = new URL(location!);
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE);
      expect(back.searchParams.get("error")).toBe(error);
      expect(back.searchParams.get("state")).toBe("st-123");
      expect(back.searchParams.get("iss")).toBe("https://shop.test");
    }
  });

  test("a parameter sent twice is refused", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const res = await call(
      `/mcp/oauth/authorize?response_type=code&client_id=${client.client_id}&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CLAUDE)}&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("a loopback redirect may use any port", async () => {
    const { body: client } = await register({ redirect_uris: ["http://127.0.0.1/callback"] });
    const { res } = await authorize(client.client_id, { redirect_uri: "http://127.0.0.1:52713/callback" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/shop\.test\/mcp\/oauth\/consent\?request=gat1\./);
  });

  test("a valid request goes to consent; the app's own page when it has one", async () => {
    const { body: client } = await register();
    expect((await authorize(client.client_id)).location).toMatch(/^https:\/\/shop\.test\/mcp\/oauth\/consent\?request=/);
    const own = appWith(oauth({ consentPath: "/oauth/consent" }));
    const { body: other } = await register({}, own);
    expect((await authorize(other.client_id, {}, own)).location).toMatch(/^https:\/\/shop\.test\/oauth\/consent\?request=gat1\./);
  });

  test("scopes the server does not know are dropped, and no scope asks for all", async () => {
    const { body: client } = await register();
    for (const [scope, expected] of [
      ["site:read openid", ["site:read"]],
      [undefined, ["site:read", "site:write"]],
    ] as const) {
      const { location } = await authorize(client.client_id, { scope });
      const page = await consentPage(location!);
      const consent = await server.consent(page.request, ALICE as any);
      expect(consent!.scopes.map((s) => s.name)).toEqual(expected);
    }
  });
});

describe("consent", () => {
  test("a signed-out user is sent to sign in, and back", async () => {
    const { body: client } = await register();
    const { location } = await authorize(client.client_id);
    const res = await call(new URL(location!).pathname + new URL(location!).search);
    expect(res.status).toBe(302);
    const signIn = new URL(res.headers.get("location")!, "https://shop.test");
    expect(signIn.pathname).toBe("/auth/sign-in");
    expect(signIn.searchParams.get("redirect")).toBe(new URL(location!).pathname + new URL(location!).search);
  });

  test("the page cannot be framed or cached, names the redirect host, and escapes the client's name", async () => {
    const { body: client } = await register({ client_name: '<img src=x onerror="alert(1)">' });
    const { location } = await authorize(client.client_id);
    const { res, html, request, csrf } = await consentPage(location!);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img");
    expect(html).toContain("claude.example");
    expect(html).toContain("alice@shop.test");
    expect(html).toContain("Read your site");
    expect(request).toMatch(/^gat1\./);
    expect(csrf).toMatch(/^gcs1\./);
  });

  test("allow sends a code back with state and iss; deny sends access_denied", async () => {
    const { back } = await codeFor();
    expect(back.searchParams.get("code")).toMatch(/^gmcp_ac_/);
    expect(back.searchParams.get("state")).toBe("st-123");
    expect(back.searchParams.get("iss")).toBe("https://shop.test");

    const { body: client } = await register();
    const page = await consentPage((await authorize(client.client_id)).location!);
    const res = await decide({ request: page.request, csrf: page.csrf, decision: "deny" });
    expect(res.status).toBe(303);
    const denied = new URL(res.headers.get("location")!);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("code")).toBeNull();
  });

  describe("CSRF", () => {
    async function page() {
      const { body: client } = await register();
      return await consentPage((await authorize(client.client_id)).location!);
    }

    test("a decision from another origin, or with no proof of origin, is refused", async () => {
      const { request, csrf } = await page();
      expect((await decide({ request, csrf, decision: "allow" }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await decide({ request, csrf, decision: "allow" }, { origin: "null" })).status).toBe(403);
      expect((await decide({ request, csrf, decision: "allow" }, { origin: null })).status).toBe(403);
      expect((await decide({ request, csrf, decision: "allow" }, { origin: null, fetchSite: "cross-site" })).status).toBe(403);
      // Same-origin without an Origin header is how some browsers post.
      const ok = await decide({ request, csrf, decision: "allow" }, { origin: null, fetchSite: "same-origin" });
      expect(ok.status).toBe(303);
    });

    test("without the CSRF token, or with one from another user or request, nothing is granted", async () => {
      const alice = await page();
      const bobsPage = await consentPage(
        (await authorize((await register()).body.client_id)).location!,
        "v2.tok-bob",
      );
      const another = await page();
      for (const fields of [
        { request: alice.request, csrf: null },
        { request: alice.request, csrf: "gcs1.e30.AAAA" },
        { request: alice.request, csrf: bobsPage.csrf },
        { request: alice.request, csrf: another.csrf },
        { request: another.request, csrf: alice.csrf },
      ]) {
        const res = await decide({ ...fields, decision: "allow" });
        expect(res.status).toBe(403);
        expect(res.headers.get("location")).toBeNull();
      }
      // Alice's page posted as Bob (a session swapped under the form).
      expect((await decide({ request: alice.request, csrf: alice.csrf, decision: "allow" }, { session: "v2.tok-bob" })).status).toBe(403);
      expect((await decide({ request: alice.request, csrf: alice.csrf, decision: "allow" }, { session: null })).status).toBe(403);
    });

    test("a decision counts once", async () => {
      const { request, csrf } = await page();
      expect((await decide({ request, csrf, decision: "deny" })).status).toBe(303);
      const again = await decide({ request, csrf, decision: "allow" });
      expect(again.status).toBe(400);
      expect(again.headers.get("location")).toBeNull();
    });

    test("a tampered request is refused", async () => {
      const { request, csrf } = await page();
      const [tag, body, mac] = request!.split(".");
      const forged = JSON.parse(Buffer.from(body, "base64url").toString());
      forged.s = ["site:read", "site:write", "admin"];
      const tampered = `${tag}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
      expect((await decide({ request: tampered, csrf, decision: "allow" })).status).toBe(403);
    });

    test("an expired request is refused", async () => {
      const { request, csrf } = await page();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60 * 1000 });
      expect((await decide({ request, csrf, decision: "allow" })).status).toBe(403);
    });
  });
});

describe("token", () => {
  test("a code with its verifier gets tokens bound to this server", async () => {
    const { tokens, res } = await connect();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "site:read site:write" });
    expect(tokens.access_token).toMatch(/^gmcp_at_/);
    expect(tokens.refresh_token).toMatch(/^gmcp_rt_/);
    const stored = await store.findToken(createHash("sha256").update(tokens.access_token).digest("hex"));
    expect(stored).toMatchObject({ kind: "access", userId: "1", resource: "https://shop.test/mcp" });
  });

  test("PKCE: a wrong or missing verifier is refused", async () => {
    for (const verifier of [pkce().verifier, undefined, "short"]) {
      const { client, code } = await codeFor();
      const res = await tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: CLAUDE,
        ...(verifier ? { code_verifier: verifier } : {}),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    }
  });

  test("a code is redeemed only by its client, at its redirect URI, for this resource", async () => {
    const { client, verifier, code } = await codeFor();
    const { body: other } = await register();
    const base = { grant_type: "authorization_code", code, code_verifier: verifier };
    expect((await (await tokenRequest({ ...base, client_id: other.client_id, redirect_uri: CLAUDE })).json()).error).toBe("invalid_grant");
    expect((await (await tokenRequest({ ...base, client_id: client.client_id, redirect_uri: "https://claude.example/other" })).json()).error).toBe("invalid_grant");

    const fresh = await codeFor();
    const wrongResource = await tokenRequest({
      grant_type: "authorization_code",
      code: fresh.code,
      code_verifier: fresh.verifier,
      client_id: fresh.client.client_id,
      resource: "https://other.test/mcp",
    });
    expect((await wrongResource.json()).error).toBe("invalid_target");
  });

  test("a code redeemed twice revokes what the first redemption got", async () => {
    const { client, verifier, code } = await codeFor();
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id };
    const first = await (await tokenRequest(form)).json();
    expect((await mcp(first.access_token)).status).toBe(200);
    const second = await tokenRequest(form);
    expect((await second.json()).error).toBe("invalid_grant");
    expect((await mcp(first.access_token)).status).toBe(401);
  });

  test("an expired code is refused", async () => {
    const { client, verifier, code } = await codeFor();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 60 * 1000 });
    const res = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
    expect((await res.json()).error).toBe("invalid_grant");
  });

  test("a confidential client proves itself, in the body or with Basic", async () => {
    const metadata = { token_endpoint_auth_method: "client_secret_basic" };
    const attempt = async (auth: (client: any) => { form?: Record<string, string>; headers?: Record<string, string> }) => {
      const { client, verifier, code } = await codeFor({ metadata });
      const { form = {}, headers = {} } = auth(client);
      return tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, ...form }, headers);
    };
    const basic = (id: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` });

    expect((await attempt((c) => ({ headers: basic(c.client_id, c.client_secret) }))).status).toBe(200);
    expect((await attempt((c) => ({ form: { client_id: c.client_id, client_secret: c.client_secret } }))).status).toBe(200);
    const wrong = await attempt((c) => ({ headers: basic(c.client_id, "gmcp_cs_wrong") }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect((await attempt((c) => ({ form: { client_id: c.client_id } }))).status).toBe(401);
  });

  test("a public client cannot be authenticated with a secret it was never given", async () => {
    const { client, verifier, code } = await codeFor();
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: "anything",
    });
    expect(res.status).toBe(401);
  });

  test("a malformed Basic header is a failed authentication, and a large body is refused as it streams", async () => {
    const bad = await tokenRequest({ grant_type: "refresh_token" }, { Authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` });
    expect(bad.status).toBe(401);
    const chunk = new TextEncoder().encode("a".repeat(8 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await call("/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(sent).toBeLessThan(64);
  });

  test("the token endpoint takes a form, once per parameter, and known grant types", async () => {
    const { body: client } = await register();
    const json = await call("/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect((await json.json()).error).toBe("invalid_request");
    const twice = await call("/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&client_id=${client.client_id}&client_id=${client.client_id}`,
    });
    expect((await twice.json()).error).toBe("invalid_request");
    const unknown = await tokenRequest({ grant_type: "client_credentials", client_id: client.client_id });
    expect((await unknown.json()).error).toBe("unsupported_grant_type");
  });

  describe("refresh", () => {
    test("rotates: the new pair works, the old access token keeps its own expiry", async () => {
      const { client, tokens } = await connect();
      const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
      const renewed = await res.json();
      expect(res.status).toBe(200);
      expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
      expect((await mcp(renewed.access_token)).status).toBe(200);
    });

    test("a refresh token used twice revokes the grant", async () => {
      const { client, tokens } = await connect();
      const form = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id };
      const renewed = await (await tokenRequest(form)).json();
      const replay = await tokenRequest(form);
      expect((await replay.json()).error).toBe("invalid_grant");
      expect((await mcp(renewed.access_token)).status).toBe(401);
      expect((await mcp(tokens.access_token)).status).toBe(401);
      const again = await tokenRequest({ ...form, refresh_token: renewed.refresh_token });
      expect((await again.json()).error).toBe("invalid_grant");
    });

    test("can narrow the scopes, never widen them", async () => {
      const { client, tokens } = await connect({ scope: "site:read" });
      const wider = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        scope: "site:read site:write",
      });
      expect((await wider.json()).error).toBe("invalid_scope");

      const both = await connect();
      const narrower = await (
        await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: both.tokens.refresh_token,
          client_id: both.client.client_id,
          scope: "site:read",
        })
      ).json();
      expect(narrower.scope).toBe("site:read");
    });

    test("only by the client it was issued to", async () => {
      const { tokens } = await connect();
      const { body: other } = await register();
      const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id });
      expect((await res.json()).error).toBe("invalid_grant");
    });
  });

  test("revocation ends the grant, for its own client only", async () => {
    const { client, tokens } = await connect();
    const { body: other } = await register();
    const revoke = (clientId: string) =>
      call("/mcp/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }).toString(),
      });
    expect((await revoke(other.client_id)).status).toBe(200);
    expect((await mcp(tokens.access_token)).status).toBe(200);
    expect((await revoke(client.client_id)).status).toBe(200);
    expect((await mcp(tokens.access_token)).status).toBe(401);
  });
});

describe("the resource server", () => {
  test("a token reaches the endpoint as its user, with its scopes and client", async () => {
    const { tokens, client } = await connect({ scope: "site:read" });
    const list = await (await mcp(tokens.access_token)).json();
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["whoami"]);
    const who = await (await mcp(tokens.access_token, "tools/call", { name: "whoami", arguments: {} })).json();
    expect(JSON.parse(who.result.content[0].text)).toMatchObject({
      id: ALICE.id,
      grant: { via: "oauth", scopes: ["site:read"], clientId: client.client_id },
    });
  });

  test("an expired, foreign-audience, refresh, or orphaned token is invalid_token", async () => {
    const { tokens } = await connect();
    const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
    const record = (await store.findToken(hashOf(tokens.access_token)))!;
    const plant = async (token: string, changes: Partial<typeof record>) => {
      await store.saveToken({ ...record, ...changes, hash: hashOf(token) });
      return token;
    };
    const cases = [
      await plant("gmcp_at_expired", { expiresAt: Date.now() - 1 }),
      await plant("gmcp_at_foreign", { resource: "https://other.test/mcp" }),
      await plant("gmcp_at_orphan", { userId: "999" }),
      await plant("gmcp_at_refresh_kind", { kind: "refresh" }),
      "gmcp_at_unknown",
    ];
    for (const token of cases) {
      const res = await mcp(token);
      expect(res.status, token).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    }
    // A refresh token is not a bearer credential here at all.
    expect((await mcp(tokens.refresh_token)).status).toBe(401);
  });

  test("API keys still work beside OAuth", async () => {
    expect((await mcp("tk_mcp_alice")).status).toBe(200);
  });

  test("refused credentials are limited per address", async () => {
    for (let i = 0; i < 30; i++) expect((await mcp("gmcp_at_guess")).status).toBe(401);
    expect((await mcp("gmcp_at_guess")).status).toBe(429);
    // A client with no credential yet is only told where to get one.
    ip += 1;
    for (let i = 0; i < 40; i++) expect((await mcp(null)).status).toBe(401);
  });
});
