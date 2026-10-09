import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../../foundation/Application";
import { LockManager } from "../../services/lock/LockManager";
import { MemoryLockStore } from "../../services/lock/MemoryLockStore";
import { ConnectionManager } from "./ConnectionManager";
import { MemoryConnectionStore } from "./ConnectionStore";
import { OAuthReconnectRequiredError } from "./errors";
import { InstagramConnectionProvider } from "./InstagramConnectionProvider";
import { OAuthConnectionProvider } from "./OAuthConnectionProvider";

/**
 * The Instagram API with Instagram Login as a connection: the code for a
 * short-lived token, that for a long-lived one, `/me` for the account; a
 * refresh that renews the access token itself (`ig_refresh_token`), never
 * one younger than 24 hours; and several accounts per user. Against a fake
 * Instagram served on 127.0.0.1.
 */

// 17 digits: more than a double holds exactly.
const IG_ID = "17841400000000123";
const IG_ID_2 = "17841400000000999";
const DAY = 24 * 60 * 60 * 1000;

type Hit = { method: string; path: string; query: Record<string, string>; form: Record<string, string>; auth: string | null };
let hits: Hit[] = [];
let codeAnswer: () => Response;
let refreshAnswer: () => Response;
let meUserId = IG_ID;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let issued = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      hits.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        form: req.method === "POST" ? Object.fromEntries(new URLSearchParams(text)) : {},
        auth: req.headers.get("authorization"),
      });
      if (url.pathname === "/oauth/access_token") return codeAnswer();
      if (url.pathname === "/access_token") {
        if (url.searchParams.get("access_token") !== "short-1") {
          return Response.json({ error: { type: "OAuthException", code: 190, message: "bad token short-x" } }, { status: 400 });
        }
        return Response.json({ access_token: "long-1", token_type: "bearer", expires_in: 5183944 });
      }
      if (url.pathname === "/refresh_access_token") return refreshAnswer();
      if (url.pathname === "/me" || url.pathname === "/v25.0/me") {
        // Raw, the way a numeric id would arrive.
        return new Response(
          `{"user_id":${meUserId},"id":"990001","username":"acme","name":"Acme","account_type":"BUSINESS","profile_picture_url":"https://cdn.example/p.jpg"}`,
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.startsWith("/api/")) {
        return Response.json({ token: req.headers.get("authorization") });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

function instagram(overrides: Partial<ConstructorParameters<typeof InstagramConnectionProvider>[0]> = {}) {
  return new InstagramConnectionProvider({
    clientId: "ig-app",
    clientSecret: "ig-secret",
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/access_token`,
    graphUrl: base,
    ...overrides,
  });
}

let store: MemoryConnectionStore;
let manager: ConnectionManager;

beforeEach(() => {
  hits = [];
  issued = 0;
  meUserId = IG_ID;
  codeAnswer = () =>
    new Response(`{"data":[{"access_token":"short-1","user_id":${IG_ID},"permissions":"instagram_business_basic,instagram_business_content_publish"}]}`);
  refreshAnswer = () => {
    issued += 1;
    return Response.json({ access_token: `renewed-${issued}`, token_type: "bearer", expires_in: 5184000 });
  };
  const application = new Application();
  application.instance(LockManager, new LockManager(new MemoryLockStore()));
  Application.setInstance(application);
  store = new MemoryConnectionStore();
  manager = new ConnectionManager({
    providers: { instagram: instagram(), accounts: instagram({ multiple: true }) },
    store,
  });
});
afterEach(() => {
  Application.setInstance(undefined);
  vi.useRealTimers();
});

const user = { id: 7 };

describe("authorization", () => {
  test("Instagram's authorize URL: comma-separated scopes, state, no PKCE, extra params kept", () => {
    const url = new URL(
      instagram({ authorizationParams: { force_reauth: "true" } }).authorizationUrl({
        state: "s1",
        codeChallenge: "c1",
        redirectUri: "https://app.example/cb",
      }),
    );
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("force_reauth")).toBe("true");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  test("the defaults are Instagram's endpoints", () => {
    const provider = new InstagramConnectionProvider({ clientId: "a", clientSecret: "b" });
    expect(provider.config.authorizeUrl).toBe("https://www.instagram.com/oauth/authorize");
    expect(provider.config.tokenUrl).toBe("https://api.instagram.com/oauth/access_token");
    expect(provider.config.apiBaseUrl).toBe("https://graph.instagram.com");
  });
});

describe("the code exchange", () => {
  test("code → short-lived → long-lived token, then /me; the 17-digit id is not rounded", async () => {
    const tokens = await instagram().exchangeCode({ code: "the-code#_", codeVerifier: "v", redirectUri: "https://app.example/cb" });

    const [exchange, longLived, me] = hits;
    expect(exchange).toMatchObject({ method: "POST", path: "/oauth/access_token" });
    expect(exchange.form).toEqual({
      client_id: "ig-app",
      client_secret: "ig-secret",
      grant_type: "authorization_code",
      redirect_uri: "https://app.example/cb",
      code: "the-code",
    });
    expect(longLived).toMatchObject({ method: "GET", path: "/access_token" });
    expect(longLived.query).toEqual({ grant_type: "ig_exchange_token", client_secret: "ig-secret", access_token: "short-1" });
    expect(me.path).toBe("/me");
    expect(me.query.access_token).toBe("long-1");
    expect(me.query.fields).toBe("user_id,username,name,account_type,profile_picture_url");

    expect(tokens.accessToken).toBe("long-1");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.providerAccountId).toBe(IG_ID);
    expect(tokens.scopes).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(tokens.profile).toEqual({
      user_id: IG_ID,
      id: "990001",
      username: "acme",
      name: "Acme",
      account_type: "BUSINESS",
      profile_picture_url: "https://cdn.example/p.jpg",
    });
  });

  test("accepts the flat response too, with permissions as an array", async () => {
    codeAnswer = () => Response.json({ access_token: "short-1", user_id: "1", permissions: ["instagram_business_basic"] });
    const tokens = await instagram().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://app.example/cb" });
    expect(tokens.scopes).toEqual(["instagram_business_basic"]);
    expect(tokens.providerAccountId).toBe(IG_ID);
  });

  test("graphApiVersion prefixes /me", async () => {
    await instagram({ graphApiVersion: "v25.0" }).exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "x" });
    expect(hits.at(-1)!.path).toBe("/v25.0/me");
  });

  test("a refused code is exchange_failed with the status, and the message carries no secret", async () => {
    codeAnswer = () =>
      Response.json({ error_type: "OAuthException", code: 400, error_message: "Matching code was not found ig-secret" }, { status: 400 });
    const error = await instagram()
      .exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "x" })
      .catch((e) => e);
    expect(error).toMatchObject({ code: "exchange_failed", status: 400 });
    expect(error.message).toContain("OAuthException");
    expect(error.message).not.toContain("ig-secret");
  });

  test("a failed long-lived exchange fails the connection", async () => {
    codeAnswer = () => Response.json({ access_token: "short-x", user_id: "1" });
    await expect(instagram().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "x" })).rejects.toMatchObject({
      code: "exchange_failed",
      status: 400,
    });
  });
});

describe("refreshing", () => {
  async function connectAt(expiresInMs: number, provider = "instagram") {
    return manager.save(user, provider, {
      accessToken: "long-1",
      expiresAt: new Date(Date.now() + expiresInMs),
      providerAccountId: IG_ID,
    });
  }

  test("renews the access token itself with ig_refresh_token, keeping the account", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connectAt(60 * DAY);
    vi.setSystemTime(Date.now() + 2 * DAY);

    const connection = (await manager.for(user, "instagram"))!;
    await connection.refresh();

    const refresh = hits.find((hit) => hit.path === "/refresh_access_token")!;
    expect(refresh.method).toBe("GET");
    expect(refresh.query).toEqual({ grant_type: "ig_refresh_token", access_token: "long-1" });
    expect(await connection.accessToken()).toBe("renewed-1");
    expect(connection.providerAccountId).toBe(IG_ID);
    expect(connection.status).toBe("connected");
    expect(connection.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  test("fetch renews a token within the leeway (10 days) before calling the API", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connectAt(15 * DAY);
    vi.setSystemTime(Date.now() + 6 * DAY);

    const res = await (await manager.for(user, "instagram"))!.fetch("/api/me");
    expect(await res.json()).toEqual({ token: "Bearer renewed-1" });
  });

  test("a token younger than 24 hours is not sent to the refresh endpoint", async () => {
    await connectAt(60 * DAY);
    const connection = (await manager.for(user, "instagram"))!;
    await connection.refresh();
    expect(hits.some((hit) => hit.path === "/refresh_access_token")).toBe(false);
    expect(await connection.accessToken()).toBe("long-1");
  });

  test("a refused refresh marks the connection needs_reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refreshAnswer = () =>
      Response.json({ error: { type: "OAuthException", code: 190, message: "Error validating access token" } }, { status: 400 });
    await connectAt(60 * DAY);
    vi.setSystemTime(Date.now() + 2 * DAY);

    const connection = (await manager.for(user, "instagram"))!;
    await expect(connection.refresh()).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect((await manager.for(user, "instagram"))!.status).toBe("needs_reconnect");
  });

  test("a 5xx from the refresh endpoint leaves the connection alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refreshAnswer = () => new Response("down", { status: 503 });
    await connectAt(60 * DAY);
    vi.setSystemTime(Date.now() + 2 * DAY);

    await expect((await manager.for(user, "instagram"))!.refresh()).rejects.toMatchObject({ code: "refresh_failed" });
    expect((await manager.for(user, "instagram"))!.status).toBe("connected");
  });

  test("revoke is unsupported (Instagram has no revocation endpoint); disconnect forgets it", async () => {
    await connectAt(60 * DAY);
    const connection = (await manager.for(user, "instagram"))!;
    await expect(connection.revoke()).rejects.toMatchObject({ code: "revoke_unsupported" });
    await connection.disconnect();
    expect(await manager.for(user, "instagram")).toBeNull();
  });
});

describe("refreshStrategy on any provider", () => {
  test("is used instead of the refresh token, and null keeps the current token", async () => {
    let answer: "renew" | "skip" = "skip";
    const seen: unknown[] = [];
    const custom = new OAuthConnectionProvider({
      authorizeUrl: "https://provider.example/oauth",
      tokenUrl: "https://provider.example/token",
      clientId: "id",
      clientSecret: "secret",
      scopes: ["read"],
      apiBaseUrl: base,
      refreshStrategy: async (ctx) => {
        seen.push(ctx);
        if (answer === "skip") return null;
        return { accessToken: "custom-2", refreshToken: null, tokenType: null, expiresAt: null, scopes: ctx.scopes, providerAccountId: null };
      },
    });
    const m = new ConnectionManager({ providers: { custom }, store: new MemoryConnectionStore() });
    await m.save(user, "custom", { accessToken: "custom-1", providerAccountId: "acct" });

    const connection = (await m.for(user, "custom"))!;
    await connection.refresh();
    expect(await connection.accessToken()).toBe("custom-1");
    expect(seen[0]).toMatchObject({ accessToken: "custom-1", refreshToken: null, scopes: ["read"], providerAccountId: "acct" });

    answer = "renew";
    await connection.refresh();
    expect(await connection.accessToken()).toBe("custom-2");
    // The account id survives a refresh that does not name it.
    expect(connection.providerAccountId).toBe("acct");
  });
});

describe("several accounts per user (multiple: true)", () => {
  const tokens = (accessToken: string, providerAccountId: string | null) => ({
    accessToken,
    providerAccountId,
    expiresAt: new Date(Date.now() + 60 * DAY),
  });

  test("each account is its own connection; connecting one again replaces only it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await manager.save(user, "accounts", tokens("a-1", IG_ID));
    vi.setSystemTime(Date.now() + 1000);
    await manager.save(user, "accounts", tokens("b-1", IG_ID_2));
    vi.setSystemTime(Date.now() + 1000);
    await manager.save(user, "accounts", tokens("a-2", IG_ID));

    const list = await manager.list(user, "accounts");
    expect(list.map((c) => [c.provider, c.providerAccountId]).sort()).toEqual([
      ["accounts", IG_ID],
      ["accounts", IG_ID_2],
    ]);
    expect(await (await manager.for(user, "accounts", IG_ID))!.accessToken()).toBe("a-2");
    expect(await (await manager.for(user, "accounts", IG_ID_2))!.accessToken()).toBe("b-1");
    expect(await manager.for(user, "accounts", "nobody")).toBeNull();
    // Without an account id: the account added most recently.
    expect((await manager.for(user, "accounts"))!.providerAccountId).toBe(IG_ID_2);
    expect((await manager.list(user)).length).toBe(2);
    expect(list[0].toJSON().provider).toBe("accounts");
  });

  test("disconnecting one leaves the others", async () => {
    await manager.save(user, "accounts", tokens("a-1", IG_ID));
    await manager.save(user, "accounts", tokens("b-1", IG_ID_2));
    await (await manager.for(user, "accounts", IG_ID))!.disconnect();
    expect((await manager.list(user, "accounts")).map((c) => c.providerAccountId)).toEqual([IG_ID_2]);
  });

  test("refreshing one account renews only that one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await manager.save(user, "accounts", tokens("a-1", IG_ID));
    await manager.save(user, "accounts", tokens("b-1", IG_ID_2));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await (await manager.for(user, "accounts", IG_ID_2))!.refresh();
    expect(await (await manager.for(user, "accounts", IG_ID))!.accessToken()).toBe("a-1");
    expect(await (await manager.for(user, "accounts", IG_ID_2))!.accessToken()).toBe("renewed-1");
  });

  test("a connection needs the account id", async () => {
    await expect(manager.save(user, "accounts", tokens("a-1", null))).rejects.toMatchObject({ code: "missing_account_id" });
  });

  test("single-account providers still replace the one connection", async () => {
    await manager.save(user, "instagram", tokens("a-1", IG_ID));
    await manager.save(user, "instagram", tokens("b-1", IG_ID_2));
    const list = await manager.list(user, "instagram");
    expect(list.map((c) => c.providerAccountId)).toEqual([IG_ID_2]);
    expect(await manager.for(user, "instagram", IG_ID)).toBeNull();
    expect((await manager.for(user, "instagram", IG_ID_2))!.providerAccountId).toBe(IG_ID_2);
  });

  test("a connection stored before multiple was turned on is still found, and replaced on reconnect", async () => {
    await store.save("7", "accounts", {
      accessToken: "old",
      refreshToken: null,
      tokenType: null,
      expiresAt: null,
      scopes: [],
      providerAccountId: IG_ID,
    });
    expect(await (await manager.for(user, "accounts", IG_ID))!.accessToken()).toBe("old");
    await manager.save(user, "accounts", tokens("new", IG_ID));
    const list = await manager.list(user, "accounts");
    expect(list.length).toBe(1);
    expect(await list[0].accessToken()).toBe("new");
  });

  test("Connections.fake answers a multiple-account provider by its name", async () => {
    const fake = manager.fake({ accounts: () => Response.json({ ok: true }) });
    await manager.save(user, "accounts", tokens("a-1", IG_ID));
    const res = await (await manager.for(user, "accounts", IG_ID))!.fetch("/api/x");
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.fakeRequests).toHaveLength(1);
    manager.restore();
  });

  test("a provider name that would clash with a multiple provider's store keys fails the boot", () => {
    expect(
      () => new ConnectionManager({ providers: { ig: instagram({ multiple: true }), "ig:x": instagram() }, store }),
    ).toThrow(/cannot be used alongside/);
  });
});
