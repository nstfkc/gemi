import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { LockManager } from "../../services/lock/LockManager";
import { MemoryLockStore } from "../../services/lock/MemoryLockStore";
import { ConnectionManager } from "./ConnectionManager";
import { MemoryConnectionStore } from "./ConnectionStore";
import { OAuthConnectionError, OAuthReconnectRequiredError } from "./errors";
import { OAuthConnectionProvider } from "./OAuthConnectionProvider";

/**
 * Spending a connection (#845): `fetch` with the bearer token, a refresh
 * before expiry and one retry after a 401, a refused refresh that marks the
 * connection, one refresh for many concurrent callers, revoke/disconnect, and
 * the token never leaving the provider's origin. Against a provider served on
 * 127.0.0.1; `localhost` on the same port counts as another origin.
 */

type Hit = { path: string; auth: string | null; form: Record<string, string> };
let hits: Hit[] = [];
let validTokens = new Set<string>();
let tokenAnswer: () => Response;
let refreshAnswer: () => Response = () => new Response("not found", { status: 404 });
let tokenDelay = 0;
let issued = 0;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      const text = await req.text();
      const form = ["/token", "/refresh", "/revoke"].includes(url.pathname) ? Object.fromEntries(new URLSearchParams(text)) : {};
      hits.push({ path: url.pathname, auth, form });
      if (url.pathname === "/token") {
        if (tokenDelay) await Bun.sleep(tokenDelay);
        return tokenAnswer();
      }
      if (url.pathname === "/refresh") return refreshAnswer();
      if (url.pathname === "/revoke") return new Response(null, { status: 200 });
      if (url.pathname === "/hop") return Response.redirect(`http://localhost:${server.port}/api/elsewhere`, 302);
      if (url.pathname === "/hop-same") return Response.redirect(`${base}/api/me`, 307);
      if (url.pathname.startsWith("/api/")) {
        const token = auth?.replace(/^Bearer /, "");
        if (!token || !validTokens.has(token)) return new Response("unauthorized", { status: 401 });
        return Response.json({ path: url.pathname, method: req.method, body: text });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

let application: Application;
let store: MemoryConnectionStore;
let manager: ConnectionManager;

function provider(overrides: Partial<ConstructorParameters<typeof OAuthConnectionProvider>[0]> = {}) {
  return new OAuthConnectionProvider({
    authorizeUrl: "https://provider.example/oauth",
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    clientId: "id",
    clientSecret: "secret",
    scopes: ["files:read"],
    apiBaseUrl: base,
    ...overrides,
  });
}

beforeEach(() => {
  hits = [];
  validTokens = new Set(["at-1"]);
  tokenDelay = 0;
  issued = 1;
  tokenAnswer = () => {
    issued += 1;
    validTokens.add(`at-${issued}`);
    return Response.json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 });
  };
  application = new Application();
  application.instance(LockManager, new LockManager(new MemoryLockStore()));
  Application.setInstance(application);
  store = new MemoryConnectionStore();
  manager = new ConnectionManager({
    providers: { figma: provider(), open: provider({ revokeUrl: undefined }) },
    store,
  });
});
afterEach(() => {
  Application.setInstance(undefined);
  vi.restoreAllMocks();
});

const user = { id: 7 };

async function connect(overrides: { expiresAt?: Date | null; refreshToken?: string | null; provider?: string } = {}) {
  return manager.save(user, overrides.provider ?? "figma", {
    accessToken: "at-1",
    refreshToken: "refreshToken" in overrides ? overrides.refreshToken! : "rt-1",
    expiresAt: "expiresAt" in overrides ? overrides.expiresAt! : new Date(Date.now() + 3600_000),
  });
}

const tokenHits = () => hits.filter((hit) => hit.path === "/token");

describe("ConnectionManager", () => {
  test("for() returns null before a connection, and refuses an unknown provider", async () => {
    expect(await manager.for(user, "figma")).toBeNull();
    await expect(manager.for(user, "nope")).rejects.toMatchObject({ code: "unknown_provider" });
    await expect(manager.for({ id: "" }, "figma")).rejects.toThrow(TypeError);
  });

  test("save() defaults the scopes to the requested ones; list() skips unconfigured providers", async () => {
    await connect();
    await store.save("7", "retired", { accessToken: "x", refreshToken: null, tokenType: null, expiresAt: null, scopes: [], providerAccountId: null });
    const connection = (await manager.for(7, "figma"))!;
    expect(connection.scopes).toEqual(["files:read"]);
    expect(connection.hasScopes("files:read")).toBe(true);
    expect(connection.hasScopes("files:read", "files:write")).toBe(false);
    expect((await manager.list(user)).map((c) => c.provider)).toEqual(["figma"]);
  });

  test("fetch sends the bearer token to a path under apiBaseUrl", async () => {
    const connection = await connect();
    const res = await connection.fetch("/api/me", { method: "POST", body: "hello" });
    expect(await res.json()).toEqual({ path: "/api/me", method: "POST", body: "hello" });
    expect(hits).toEqual([{ path: "/api/me", auth: "Bearer at-1", form: {} }]);
  });

  test("fetch refreshes first when the token is about to expire", async () => {
    const connection = await connect({ expiresAt: new Date(Date.now() + 30_000) }); // inside the 60s leeway
    const res = await connection.fetch("/api/me");
    expect(res.status).toBe(200);
    expect(hits.map((h) => h.path)).toEqual(["/token", "/api/me"]);
    expect(hits[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1" });
    expect(hits[1].auth).toBe("Bearer at-2");
    const stored = await store.find("7", "figma");
    expect(stored).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
  });

  test("a 401 refreshes and retries once", async () => {
    const connection = await connect();
    validTokens.delete("at-1"); // revoked early by the provider
    const res = await connection.fetch("/api/me");
    expect(res.status).toBe(200);
    expect(hits.map((h) => [h.path, h.auth])).toEqual([
      ["/api/me", "Bearer at-1"],
      ["/token", null],
      ["/api/me", "Bearer at-2"],
    ]);
  });

  test("a second 401 is returned, not retried again", async () => {
    const connection = await connect();
    validTokens.clear();
    tokenAnswer = () => Response.json({ access_token: "still-bad" });
    const res = await connection.fetch("/api/me");
    expect(res.status).toBe(401);
    expect(hits.map((h) => h.path)).toEqual(["/api/me", "/token", "/api/me"]);
  });

  test("a streamed body is not sent twice", async () => {
    const connection = await connect();
    validTokens.clear();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    });
    const res = await connection.fetch("/api/me", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(401);
    expect(tokenHits()).toHaveLength(0);
  });

  test("a refused refresh marks the connection and throws OAuthReconnectRequiredError", async () => {
    const connection = await connect({ expiresAt: new Date(Date.now() - 1000) });
    tokenAnswer = () => Response.json({ error: "invalid_grant" }, { status: 400 });

    const error = await connection.fetch("/api/me").catch((e) => e);
    expect(error).toBeInstanceOf(OAuthReconnectRequiredError);
    expect(error).toMatchObject({ code: "reconnect_required", provider: "figma", status: 400, providerError: "invalid_grant" });
    expect(connection.needsReconnect).toBe(true);
    expect((await store.find("7", "figma"))?.needsReconnect).toBe(true);

    // Later calls fail without asking the provider again, from a fresh handle too.
    hits = [];
    await expect((await manager.for(user, "figma"))!.fetch("/api/me")).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect(hits).toHaveLength(0);

    // Connecting again clears it.
    await connect();
    expect((await manager.for(user, "figma"))!.needsReconnect).toBe(false);
  });

  test("a refused refresh shows in status and toJSON, so the app does not show the connection as working", async () => {
    const connection = await connect({ expiresAt: new Date(Date.now() - 1000) });
    expect(connection.status).toBe("connected");
    tokenAnswer = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await connection.accessToken().catch(() => {});

    const listed = await manager.list(user);
    expect(listed.map((c) => c.status)).toEqual(["needs_reconnect"]);
    expect(JSON.parse(JSON.stringify(listed[0]))).toMatchObject({ needsReconnect: true, status: "needs_reconnect" });
  });

  test("an expired connection without a refresh token reports needs_reconnect before any call", async () => {
    expect((await connect({ refreshToken: null, expiresAt: new Date(Date.now() - 1000) })).status).toBe("needs_reconnect");
    expect((await connect({ refreshToken: null, expiresAt: null })).status).toBe("connected");
    expect((await connect({ refreshToken: null, expiresAt: new Date(Date.now() + 60_000) })).status).toBe("connected");
  });

  test("invalid_client (the app's own credentials) does not mark the connection", async () => {
    const connection = await connect({ expiresAt: new Date(Date.now() - 1000) });
    tokenAnswer = () => Response.json({ error: "invalid_client" }, { status: 401 });
    const error = await connection.accessToken().catch((e) => e);
    expect(error).not.toBeInstanceOf(OAuthReconnectRequiredError);
    expect(error).toMatchObject({ code: "refresh_failed", status: 401, providerError: "invalid_client" });
    expect((await store.find("7", "figma"))?.needsReconnect).toBe(false);

    // Once the config is fixed, the same refresh token works.
    tokenAnswer = () => Response.json({ access_token: "at-9", expires_in: 3600 });
    expect(await connection.accessToken()).toBe("at-9");
  });

  test("a provider with its own refresh endpoint is refreshed there", async () => {
    manager = new ConnectionManager({
      providers: {
        figma: provider({ refreshUrl: `${base}/refresh`, refreshGrantType: false, clientAuth: "basic" }),
      },
      store,
    });
    const connection = await connect({ expiresAt: new Date(Date.now() - 1000) });
    validTokens.add("at-fig");
    refreshAnswer = () => Response.json({ access_token: "at-fig", expires_in: 3600 });
    const res = await connection.fetch("/api/me");
    expect(res.status).toBe(200);
    const refresh = hits.find((hit) => hit.path === "/refresh")!;
    expect(refresh.form).toEqual({ refresh_token: "rt-1" });
    expect(refresh.auth).toMatch(/^Basic /);
    expect(tokenHits()).toHaveLength(0);
    // Figma does not rotate: the stored refresh token is still the first one.
    expect((await store.find("7", "figma"))?.refreshToken).toBe("rt-1");
  });

  test("a 5xx or network error during refresh leaves the connection alone", async () => {
    const connection = await connect({ expiresAt: new Date(Date.now() - 1000) });
    tokenAnswer = () => new Response("down", { status: 503 });
    const error = await connection.accessToken().catch((e) => e);
    expect(error).toBeInstanceOf(OAuthConnectionError);
    expect(error).not.toBeInstanceOf(OAuthReconnectRequiredError);
    expect(error).toMatchObject({ code: "refresh_failed", status: 503 });
    expect((await store.find("7", "figma"))?.needsReconnect).toBe(false);
  });

  test("no refresh token: an expired connection needs reconnecting", async () => {
    const connection = await connect({ refreshToken: null, expiresAt: new Date(Date.now() - 1000) });
    await expect(connection.accessToken()).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect(tokenHits()).toHaveLength(0);
  });

  test("concurrent callers share one refresh, and a rotated refresh token is spent once", async () => {
    await connect({ expiresAt: new Date(Date.now() - 1000) });
    tokenDelay = 30;
    const handles = await Promise.all([1, 2, 3].map(() => manager.for(user, "figma")));
    const tokens = await Promise.all([...handles, ...handles].map((c) => c!.accessToken()));
    expect(new Set(tokens)).toEqual(new Set(["at-2"]));
    expect(tokenHits()).toHaveLength(1);
  });

  test("a refresh another process already made is picked up instead of repeated", async () => {
    const stale = (await connect())!;
    // Another process refreshes: the stored revision moves on.
    const current = (await store.find("7", "figma"))!;
    validTokens.add("at-other");
    await store.updateTokens(current.id, current.revision, {
      accessToken: "at-other",
      refreshToken: "rt-other",
      tokenType: null,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["files:read"],
      providerAccountId: null,
    });
    validTokens.delete("at-1");
    const res = await stale.fetch("/api/me");
    expect(res.status).toBe(200);
    expect(tokenHits()).toHaveLength(0);
    expect(hits.at(-1)?.auth).toBe("Bearer at-other");
  });

  test("refresh() refreshes now", async () => {
    const connection = await connect();
    await connection.refresh();
    expect(await connection.accessToken()).toBe("at-2");
  });

  test("refuses to send the token outside apiBaseUrl, or over plain http", async () => {
    const connection = await connect();
    await expect(connection.fetch("https://evil.example/steal")).rejects.toMatchObject({ code: "forbidden_url" });
    await expect(connection.fetch(`http://localhost:${server.port}/api/me`)).rejects.toMatchObject({ code: "forbidden_url" });
    expect(hits).toHaveLength(0);

    // An absolute URL on apiBaseUrl's origin is fine.
    expect((await connection.fetch(`${base}/api/me`)).status).toBe(200);
  });

  test("drops the token on a redirect to another origin, keeps it on the same one", async () => {
    const connection = await connect();
    validTokens.add("at-1");
    const same = await connection.fetch("/hop-same");
    expect(same.status).toBe(200);
    expect(hits.map((h) => [h.path, h.auth])).toEqual([
      ["/hop-same", "Bearer at-1"],
      ["/api/me", "Bearer at-1"],
    ]);

    hits = [];
    const other = await connection.fetch("/hop");
    expect(other.status).toBe(401); // no token at the other origin, and no refresh for its 401
    expect(hits.map((h) => [h.path, h.auth])).toEqual([
      ["/hop", "Bearer at-1"],
      ["/api/elsewhere", null],
    ]);
  });

  test("revoke() revokes the refresh token at the provider and deletes the connection", async () => {
    const connection = await connect();
    await connection.revoke();
    expect(hits).toEqual([
      { path: "/revoke", auth: null, form: { token: "rt-1", token_type_hint: "refresh_token", client_id: "id", client_secret: "secret" } },
    ]);
    expect(await manager.for(user, "figma")).toBeNull();
  });

  test("a refused revocation deletes nothing; disconnect() forgets locally", async () => {
    const connection = await connect({ provider: "open" });
    await expect(connection.revoke()).rejects.toMatchObject({ code: "revoke_unsupported" });
    expect(await manager.for(user, "open")).not.toBeNull();
    await connection.disconnect();
    expect(await manager.for(user, "open")).toBeNull();
    expect(hits).toHaveLength(0);
  });

  test("serialises and inspects without tokens", async () => {
    const connection = await connect();
    const json = JSON.stringify(connection);
    const inspected = inspect(connection, { depth: 5 });
    for (const text of [json, inspected]) {
      expect(text).not.toContain("at-1");
      expect(text).not.toContain("rt-1");
      expect(text).toContain("figma");
    }
  });

  test("fake() answers API calls in memory and calls no token endpoint", async () => {
    const fake = manager.fake({ figma: (req) => Response.json({ url: req.url, auth: req.headers.get("authorization") }) });
    const connection = await fake.save(user, "figma", { accessToken: "test-token", expiresAt: new Date(0) });
    const res = await connection.fetch("/v1/files/abc");
    expect(await res.json()).toEqual({ url: `${base}/v1/files/abc`, auth: "Bearer test-token" });
    expect(fake.fakeRequests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/files/abc"]);
    await connection.revoke();
    expect(hits).toHaveLength(0);
    expect(await store.find("7", "figma")).toBeNull();

    manager.restore();
    expect(manager.faked).toBe(false);
    expect(await manager.for(user, "figma")).toBeNull();
    await connect();
    await expect(manager.fake().for(user, "figma")).resolves.toBeNull();
    await expect((await manager.save(user, "figma", { accessToken: "t" })).fetch("/x")).rejects.toThrow(/no handler for "figma"/);
  });
});
