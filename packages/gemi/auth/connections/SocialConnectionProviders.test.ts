import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { Application } from "../../foundation/Application";
import { LockManager } from "../../services/lock/LockManager";
import { MemoryLockStore } from "../../services/lock/MemoryLockStore";
import { ConnectionManager } from "./ConnectionManager";
import { MemoryConnectionStore } from "./ConnectionStore";
import { OAuthReconnectRequiredError } from "./errors";
import { FacebookConnectionProvider, FacebookPage } from "./FacebookConnectionProvider";
import { LINKEDIN_ORGANIZATION_SCOPES, LinkedInConnectionProvider } from "./LinkedInConnectionProvider";
import type { OAuthConnectionProvider } from "./OAuthConnectionProvider";
import { TikTokConnectionProvider } from "./TikTokConnectionProvider";
import { XConnectionProvider } from "./XConnectionProvider";
import { YouTubeConnectionProvider } from "./YouTubeConnectionProvider";

/**
 * The ready-made publishing connections (#1299): Facebook Pages, LinkedIn,
 * TikTok, YouTube and X. Each platform is a fake served on 127.0.0.1; nothing
 * leaves the machine and no credential is real.
 */

type Hit = {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  headers: Headers;
};
type Route = (hit: Hit) => Response | Promise<Response>;

let hits: Hit[] = [];
let routes: Record<string, Route> = {};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      const hit: Hit = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        form: req.method === "POST" ? Object.fromEntries(new URLSearchParams(text)) : {},
        headers: req.headers,
      };
      hits.push(hit);
      const route = routes[`${req.method} ${url.pathname}`];
      return route ? route(hit) : new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

beforeEach(() => {
  hits = [];
  routes = {};
  const application = new Application();
  application.instance(LockManager, new LockManager(new MemoryLockStore()));
  Application.setInstance(application);
});
afterEach(() => Application.setInstance(undefined));

const user = { id: 7 };
const redirectUri = "https://app.example/auth/connections/p/callback";

function managerFor(provider: OAuthConnectionProvider) {
  return new ConnectionManager({ providers: { p: provider }, store: new MemoryConnectionStore() });
}

function bearer(hit: Hit): string | null {
  return hit.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

function authorize(provider: OAuthConnectionProvider): URL {
  return new URL(provider.authorizationUrl({ state: "st", codeChallenge: "cc", redirectUri }));
}

async function connect(provider: OAuthConnectionProvider) {
  const manager = managerFor(provider);
  const tokens = await provider.exchangeCode({ code: "code-1", codeVerifier: "verifier-1", redirectUri });
  const connection = await manager.save(user, "p", tokens);
  return { manager, tokens, connection };
}

// --- X -----------------------------------------------------------------------

describe("XConnectionProvider", () => {
  function x(overrides: ConstructorParameters<typeof XConnectionProvider>[0] = {}) {
    return new XConnectionProvider({
      clientId: "x-id",
      clientSecret: "x-secret",
      tokenUrl: `${base}/2/oauth2/token`,
      revokeUrl: `${base}/2/oauth2/revoke`,
      apiBaseUrl: base,
      ...overrides,
    });
  }

  beforeEach(() => {
    let issued = 0;
    routes["POST /2/oauth2/token"] = (hit) => {
      if (hit.form.grant_type === "refresh_token" && hit.form.refresh_token !== `x-rt-${issued}`) {
        return Response.json({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, { status: 400 });
      }
      issued += 1;
      return Response.json({
        token_type: "bearer",
        expires_in: 7200,
        access_token: `x-at-${issued}`,
        refresh_token: `x-rt-${issued}`,
        scope: "tweet.read tweet.write users.read media.write offline.access",
      });
    };
    routes["GET /2/users/me"] = (hit) =>
      bearer(hit) === `x-at-${issued}`
        ? Response.json({
            data: { id: "1445880548472328192", name: "Acme", username: "acme", profile_image_url: "https://pbs.example/a.jpg" },
          })
        : Response.json({ title: "Unauthorized" }, { status: 401 });
    routes["POST /2/oauth2/revoke"] = () => Response.json({ revoked: true });
  });

  test("authorize URL: PKCE S256, space-separated scopes with media.write and offline.access", () => {
    const url = authorize(new XConnectionProvider({ clientId: "x-id", clientSecret: "s" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read media.write offline.access");
    expect(url.searchParams.get("code_challenge")).toBe("cc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("x-id");
  });

  test("exchanges with HTTP Basic and the PKCE verifier, and reads the account", async () => {
    const { tokens, connection } = await connect(x({ multiple: true }));
    const exchange = hits.find((hit) => hit.path === "/2/oauth2/token")!;
    expect(exchange.headers.get("authorization")).toBe(basic("x-id", "x-secret"));
    expect(exchange.form).toMatchObject({ grant_type: "authorization_code", code: "code-1", code_verifier: "verifier-1" });
    expect(exchange.form.client_secret).toBeUndefined();
    expect(tokens.profile).toEqual({
      id: "1445880548472328192",
      name: "Acme",
      username: "acme",
      avatarUrl: "https://pbs.example/a.jpg",
    });
    expect(connection.providerAccountId).toBe("1445880548472328192");
    expect(connection.scopes).toContain("media.write");
  });

  test("a 401 refreshes once with the rotated refresh token and retries", async () => {
    const { connection } = await connect(x());
    // Rotate behind the connection's back: the stored access token is now stale.
    routes["GET /2/users/me"] = (hit) =>
      bearer(hit) === "x-at-2"
        ? Response.json({ data: { id: "1445880548472328192", name: "Acme", username: "acme" } })
        : Response.json({}, { status: 401 });
    // The exchange issued x-at-1; the API now only takes x-at-2.
    const provider = connection.connectionProvider() as XConnectionProvider;
    const profile = await provider.profile(connection);
    expect(profile.username).toBe("acme");
    expect(hits.filter((hit) => hit.form.grant_type === "refresh_token")).toHaveLength(1);
    expect(hits.find((hit) => hit.form.grant_type === "refresh_token")!.form.refresh_token).toBe("x-rt-1");
  });

  test("revoke() revokes the refresh token with HTTP Basic", async () => {
    const { manager, connection } = await connect(x());
    await connection.revoke();
    const revoke = hits.find((hit) => hit.path === "/2/oauth2/revoke")!;
    expect(revoke.form).toMatchObject({ token: "x-rt-1", token_type_hint: "refresh_token" });
    expect(revoke.headers.get("authorization")).toBe(basic("x-id", "x-secret"));
    expect(await manager.for(user, "p")).toBeNull();
  });
});

// --- YouTube -----------------------------------------------------------------

describe("YouTubeConnectionProvider", () => {
  function youtube() {
    return new YouTubeConnectionProvider({
      clientId: "g-id",
      clientSecret: "g-secret",
      tokenUrl: `${base}/token`,
      revokeUrl: `${base}/revoke`,
      apiBaseUrl: base,
    });
  }

  beforeEach(() => {
    routes["POST /token"] = (hit) =>
      hit.form.grant_type === "refresh_token"
        ? hit.form.refresh_token === "g-rt"
          ? Response.json({ access_token: "g-at-2", expires_in: 3599, token_type: "Bearer", scope: "https://www.googleapis.com/auth/youtube.upload" })
          : Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({
            access_token: "g-at-1",
            refresh_token: "g-rt",
            expires_in: 3599,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          });
    routes["GET /youtube/v3/channels"] = (hit) =>
      hit.query.mine === "true" && bearer(hit)?.startsWith("g-at-")
        ? Response.json({
            items: [
              {
                id: "UCabc123",
                snippet: {
                  title: "Acme TV",
                  customUrl: "@acmetv",
                  thumbnails: { default: { url: "https://yt.example/d.jpg" }, high: { url: "https://yt.example/h.jpg" } },
                },
              },
            ],
          })
        : Response.json({ error: { code: 401 } }, { status: 401 });
    routes["POST /revoke"] = () => new Response(null, { status: 200 });
  });

  test("authorize URL: youtube.upload, offline access with consent, PKCE", () => {
    const url = authorize(new YouTubeConnectionProvider({ clientId: "g-id", clientSecret: "s" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/youtube.upload");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("exchange keeps the refresh token and names the channel", async () => {
    const { tokens, connection } = await connect(youtube());
    expect(tokens.refreshToken).toBe("g-rt");
    expect(tokens.profile).toEqual({ id: "UCabc123", name: "Acme TV", username: "@acmetv", avatarUrl: "https://yt.example/h.jpg" });
    expect(connection.providerAccountId).toBe("UCabc123");
    expect(hits.find((hit) => hit.path === "/token")!.form).toMatchObject({ client_id: "g-id", client_secret: "g-secret" });
  });

  test("an expiring token is refreshed before the call, and the refresh token is kept", async () => {
    const { manager } = await connect(youtube());
    await manager.save(user, "p", {
      accessToken: "g-at-old",
      refreshToken: "g-rt",
      expiresAt: new Date(Date.now() + 1000),
    });
    const connection = (await manager.for(user, "p"))!;
    expect(await connection.accessToken()).toBe("g-at-2");
    await connection.refresh();
    expect(hits.filter((hit) => hit.form.grant_type === "refresh_token").every((hit) => hit.form.refresh_token === "g-rt")).toBe(true);
  });

  test("a refused refresh marks the connection", async () => {
    const { manager } = await connect(youtube());
    const connection = await manager.save(user, "p", { accessToken: "g-at-old", refreshToken: "g-revoked" });
    await expect(connection.refresh()).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect((await manager.for(user, "p"))!.status).toBe("needs_reconnect");
  });

  test("a Google account without a channel fails the connect", async () => {
    routes["GET /youtube/v3/channels"] = () => Response.json({ items: [] });
    await expect(connect(youtube())).rejects.toMatchObject({ code: "exchange_failed" });
  });

  test("revoke() revokes the refresh token at Google", async () => {
    const { connection } = await connect(youtube());
    await connection.revoke();
    expect(hits.find((hit) => hit.path === "/revoke")!.form).toMatchObject({ token: "g-rt" });
  });
});

// --- TikTok ------------------------------------------------------------------

describe("TikTokConnectionProvider", () => {
  function tiktok(overrides: ConstructorParameters<typeof TikTokConnectionProvider>[0] = {}) {
    return new TikTokConnectionProvider({
      clientKey: "tt-key",
      clientSecret: "tt-secret",
      tokenUrl: `${base}/v2/oauth/token/`,
      revokeUrl: `${base}/v2/oauth/revoke/`,
      apiBaseUrl: base,
      ...overrides,
    });
  }

  beforeEach(() => {
    routes["POST /v2/oauth/token/"] = (hit) => {
      if (hit.form.grant_type === "refresh_token") {
        // TikTok answers some refusals with a 200.
        if (hit.form.refresh_token !== "tt-rt-1") {
          return Response.json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired.", log_id: "x" });
        }
        return Response.json({ access_token: "tt-at-2", refresh_token: "tt-rt-2", expires_in: 7200, open_id: "-000abc", scope: "user.info.basic,video.publish", token_type: "Bearer" });
      }
      return Response.json({
        access_token: "tt-at-1",
        expires_in: 7200,
        open_id: "-000abc",
        refresh_expires_in: 15552000,
        refresh_token: "tt-rt-1",
        scope: "user.info.basic,video.publish,video.upload",
        token_type: "Bearer",
      });
    };
    routes["GET /v2/user/info/"] = (hit) =>
      bearer(hit)?.startsWith("tt-at-")
        ? Response.json({
            data: { user: { open_id: "-000abc", union_id: "u-1", display_name: "Acme", avatar_url: "https://tt.example/a.jpg", fields: hit.query.fields } },
            error: { code: "ok", message: "", log_id: "l" },
          })
        : Response.json({ data: {}, error: { code: "access_token_invalid", message: "", log_id: "l" } }, { status: 401 });
    routes["POST /v2/oauth/revoke/"] = () => Response.json({});
  });

  test("authorize URL: client_key, comma-separated scopes, no PKCE", () => {
    const url = authorize(new TikTokConnectionProvider({ clientKey: "tt-key", clientSecret: "s" }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("tt-key");
    expect(url.searchParams.has("client_id")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish,video.upload");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  test("exchange sends client_key, names the account by open_id and reads the user", async () => {
    const { tokens, connection } = await connect(tiktok());
    const exchange = hits.find((hit) => hit.path === "/v2/oauth/token/")!;
    expect(exchange.form).toMatchObject({ client_key: "tt-key", client_secret: "tt-secret", grant_type: "authorization_code", code: "code-1" });
    expect(exchange.form.client_id).toBeUndefined();
    expect(tokens.profile).toEqual({ id: "-000abc", name: "Acme", username: null, avatarUrl: "https://tt.example/a.jpg", unionId: "u-1" });
    expect(connection.scopes).toEqual(["user.info.basic", "video.publish", "video.upload"]);
    // No `user.info.profile`, so no `username` field (TikTok would refuse the call).
    expect(hits.find((hit) => hit.path === "/v2/user/info/")!.query.fields).toBe("open_id,union_id,avatar_url,display_name");
  });

  test("refresh rotates the refresh token", async () => {
    const { connection, manager } = await connect(tiktok());
    await connection.refresh();
    expect(await connection.accessToken()).toBe("tt-at-2");
    await expect((await manager.for(user, "p"))!.status).toBe("connected");
    expect(hits.find((hit) => hit.form.grant_type === "refresh_token")!.form).toMatchObject({ client_key: "tt-key", refresh_token: "tt-rt-1" });
  });

  test("a refusal answered with HTTP 200 still marks the connection", async () => {
    const { manager } = await connect(tiktok());
    const stale = await manager.save(user, "p", { accessToken: "tt-at-x", refreshToken: "tt-rt-old", providerAccountId: "-000abc" });
    await expect(stale.refresh()).rejects.toMatchObject({ code: "reconnect_required", providerError: "invalid_grant", status: 400 });
    expect((await manager.for(user, "p"))!.needsReconnect).toBe(true);
  });

  test("revoke() revokes the access token, not the refresh token", async () => {
    const { connection } = await connect(tiktok());
    await connection.revoke();
    expect(hits.find((hit) => hit.path === "/v2/oauth/revoke/")!.form).toMatchObject({
      client_key: "tt-key",
      client_secret: "tt-secret",
      token: "tt-at-1",
    });
  });
});

// --- LinkedIn ----------------------------------------------------------------

describe("LinkedInConnectionProvider", () => {
  function linkedin(overrides: ConstructorParameters<typeof LinkedInConnectionProvider>[0] = {}) {
    return new LinkedInConnectionProvider({
      clientId: "li-id",
      clientSecret: "li-secret",
      tokenUrl: `${base}/oauth/v2/accessToken`,
      apiBaseUrl: base,
      ...overrides,
    });
  }

  beforeEach(() => {
    routes["POST /oauth/v2/accessToken"] = () =>
      Response.json({ access_token: "li-at", expires_in: 5183999, scope: "openid,profile,w_member_social,w_organization_social,r_organization_social", token_type: "Bearer", id_token: "jwt" });
    routes["GET /v2/userinfo"] = (hit) =>
      bearer(hit) === "li-at"
        ? Response.json({ sub: "782bbtaQ", name: "Ada Lovelace", given_name: "Ada", family_name: "Lovelace", picture: "https://media.example/ada.jpg", locale: "en-US" })
        : Response.json({}, { status: 401 });
    routes["GET /rest/organizationAcls"] = (hit) =>
      Response.json({
        elements: [
          { organization: "urn:li:organization:2414183", role: "ADMINISTRATOR", state: "APPROVED", seen: hit.headers.get("linkedin-version") },
          { organization: "urn:li:organization:5590506", role: "DIRECT_SPONSORED_CONTENT_POSTER", state: "APPROVED" },
        ],
      });
    routes["GET /rest/organizations"] = (hit) =>
      hit.query.ids === "List(2414183,5590506)" && hit.headers.get("x-restli-protocol-version") === "2.0.0"
        ? Response.json({ results: { "2414183": { id: 2414183, localizedName: "Acme Corp", vanityName: "acme" } } })
        : Response.json({}, { status: 400 });
  });

  test("authorize URL: openid profile w_member_social, space-separated, no PKCE", () => {
    const url = authorize(new LinkedInConnectionProvider({ clientId: "li-id", clientSecret: "s" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  test("exchange reads the member through OpenID userinfo", async () => {
    const { tokens, connection } = await connect(linkedin({ scopes: ["openid", "profile", "w_member_social", ...LINKEDIN_ORGANIZATION_SCOPES] }));
    expect(tokens.profile).toEqual({
      id: "782bbtaQ",
      name: "Ada Lovelace",
      username: null,
      avatarUrl: "https://media.example/ada.jpg",
      authorUrn: "urn:li:person:782bbtaQ",
      email: null,
    });
    expect(connection.hasScopes("w_member_social", "w_organization_social")).toBe(true);
    expect(hits.find((hit) => hit.path === "/oauth/v2/accessToken")!.form).toMatchObject({ client_id: "li-id", client_secret: "li-secret", grant_type: "authorization_code" });
  });

  test("organizations() lists the member's organizations with the versioned headers", async () => {
    const provider = linkedin({ apiVersion: "202601" });
    const { connection } = await connect(provider);
    expect(await provider.organizations(connection)).toEqual([
      { id: "2414183", urn: "urn:li:organization:2414183", role: "ADMINISTRATOR", name: "Acme Corp", vanityName: "acme" },
      { id: "5590506", urn: "urn:li:organization:5590506", role: "DIRECT_SPONSORED_CONTENT_POSTER", name: null, vanityName: null },
    ]);
    expect(hits.find((hit) => hit.path === "/rest/organizationAcls")!.headers.get("linkedin-version")).toBe("202601");
  });

  test("without a refresh token, a refused token needs a reconnect", async () => {
    const { manager, connection } = await connect(linkedin());
    routes["GET /v2/userinfo"] = () => Response.json({}, { status: 401 });
    const provider = connection.connectionProvider() as LinkedInConnectionProvider;
    await expect(provider.profile(connection)).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect((await manager.for(user, "p"))!.status).toBe("needs_reconnect");
  });

  test("revoke() is unsupported (LinkedIn documents no endpoint); disconnect() forgets the tokens", async () => {
    const { manager, connection } = await connect(linkedin());
    await expect(connection.revoke()).rejects.toMatchObject({ code: "revoke_unsupported" });
    await connection.disconnect();
    expect(await manager.for(user, "p")).toBeNull();
  });
});

// --- Facebook ----------------------------------------------------------------

describe("FacebookConnectionProvider", () => {
  function facebook(overrides: ConstructorParameters<typeof FacebookConnectionProvider>[0] = {}) {
    return new FacebookConnectionProvider({
      clientId: "fb-app",
      clientSecret: "fb-secret",
      apiBaseUrl: base,
      dialogUrl: base,
      graphApiVersion: "v24.0",
      ...overrides,
    });
  }

  let liveUserTokens: Set<string>;
  beforeEach(() => {
    liveUserTokens = new Set(["fb-long"]);
    routes["GET /v24.0/oauth/access_token"] = (hit) => {
      if (hit.query.grant_type === "fb_exchange_token") {
        return hit.query.fb_exchange_token === "fb-short"
          ? Response.json({ access_token: "fb-long", token_type: "bearer", expires_in: 5183944 })
          : Response.json({ error: { type: "OAuthException", code: 190 } }, { status: 400 });
      }
      return hit.query.code === "code-1" && hit.query.client_secret === "fb-secret"
        ? Response.json({ access_token: "fb-short", token_type: "bearer", expires_in: 5400 })
        : Response.json({ error: { type: "OAuthException", code: 100 } }, { status: 400 });
    };
    const guarded = (answer: (hit: Hit) => Response): Route => (hit) =>
      liveUserTokens.has(hit.query.access_token ?? "")
        ? answer(hit)
        : Response.json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, { status: 400 });
    routes["GET /v24.0/me"] = guarded(() =>
      new Response(`{"id":"10158000000000123","name":"Ada","picture":{"data":{"url":"https://fb.example/ada.jpg"}}}`),
    );
    routes["GET /v24.0/me/permissions"] = guarded(() =>
      Response.json({
        data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "pages_manage_posts", status: "granted" },
          { permission: "pages_read_engagement", status: "declined" },
        ],
      }),
    );
    routes["GET /v24.0/me/accounts"] = guarded((hit) =>
      hit.query.after === "p2"
        ? Response.json({ data: [{ id: "222", name: "Second", category: "Cafe", tasks: ["MODERATE"], access_token: "page-222" }] })
        : Response.json({
            data: [
              { id: "111", name: "Acme", category: "Bakery", tasks: ["CREATE_CONTENT", "MANAGE"], access_token: "page-111", picture: { data: { url: "https://fb.example/111.jpg" } } },
            ],
            paging: { next: `${base}/v24.0/me/accounts?after=p2&access_token=${hit.query.access_token}` },
          }),
    );
    routes["POST /v24.0/111/feed"] = (hit) =>
      hit.query.access_token === "page-111" ? Response.json({ id: "111_999" }) : Response.json({}, { status: 400 });
    routes["DELETE /v24.0/me/permissions"] = (hit) =>
      liveUserTokens.has(hit.query.access_token ?? "") ? Response.json({ success: true }) : Response.json({}, { status: 400 });
  });

  test("authorize URL: comma-separated Page scopes, or a Login for Business config_id in their place", () => {
    const plain = authorize(facebook());
    expect(plain.pathname).toBe("/v24.0/dialog/oauth");
    expect(plain.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,pages_manage_posts");
    expect(plain.searchParams.has("code_challenge")).toBe(false);

    const business = authorize(facebook({ configId: "cfg-42" }));
    expect(business.searchParams.get("config_id")).toBe("cfg-42");
    expect(business.searchParams.has("scope")).toBe(false);
  });

  test("exchange: short-lived token, long-lived token, then the user, granted permissions and Pages", async () => {
    const { tokens, connection } = await connect(facebook());
    expect(tokens.accessToken).toBe("fb-long");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.providerAccountId).toBe("10158000000000123");
    expect(connection.scopes).toEqual(["pages_show_list", "pages_manage_posts"]);
    expect(tokens.profile).toEqual({
      id: "10158000000000123",
      name: "Ada",
      username: null,
      avatarUrl: "https://fb.example/ada.jpg",
      pages: [
        { id: "111", name: "Acme", category: "Bakery", tasks: ["CREATE_CONTENT", "MANAGE"], avatarUrl: "https://fb.example/111.jpg" },
        { id: "222", name: "Second", category: "Cafe", tasks: ["MODERATE"], avatarUrl: null },
      ],
    });
    // The profile handed to onConnected never carries a Page token.
    expect(JSON.stringify(tokens.profile)).not.toContain("page-");
  });

  test("pages() gives each Page its own token, spent on the Graph API only", async () => {
    const provider = facebook();
    const { connection } = await connect(provider);
    const pages = await provider.pages(connection);
    expect(pages.map((page) => [page.id, page.canPost])).toEqual([
      ["111", true],
      ["222", false],
    ]);
    expect(pages[0]).toBeInstanceOf(FacebookPage);
    expect(JSON.stringify(pages[0])).not.toContain("page-111");
    expect(pages[0].accessToken()).toBe("page-111");

    const posted = await pages[0].fetch("/v24.0/111/feed", { method: "POST", body: new URLSearchParams({ message: "hi" }) });
    expect(await posted.json()).toEqual({ id: "111_999" });
    await expect(pages[0].fetch("https://evil.example/steal")).rejects.toMatchObject({ code: "forbidden_url" });
  });

  test("a refused user token (OAuthException 190) marks the connection: Facebook has no refresh", async () => {
    const provider = facebook();
    const { manager, connection } = await connect(provider);
    liveUserTokens.clear();
    await expect(provider.pages(connection)).rejects.toBeInstanceOf(OAuthReconnectRequiredError);
    expect((await manager.for(user, "p"))!.status).toBe("needs_reconnect");
  });

  test("an expired user token reads needs_reconnect without calling Facebook", async () => {
    const { manager } = await connect(facebook());
    const expired = await manager.save(user, "p", { accessToken: "fb-long", expiresAt: new Date(Date.now() - 1000) });
    expect(expired.status).toBe("needs_reconnect");
  });

  test("revoke() removes the app's permissions with the user token", async () => {
    const { manager, connection } = await connect(facebook());
    await connection.revoke();
    expect(hits.find((hit) => hit.method === "DELETE")).toMatchObject({ path: "/v24.0/me/permissions", query: { access_token: "fb-long" } });
    expect(await manager.for(user, "p")).toBeNull();
  });

  test("Connections.fake() answers Page calls too", async () => {
    const provider = facebook();
    const manager = managerFor(provider).fake({
      p: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v24.0/me/accounts") {
          return Response.json({ data: [{ id: "111", name: "Acme", tasks: ["CREATE_CONTENT"], access_token: "fake-page" }] });
        }
        return Response.json({ token: url.searchParams.get("access_token") });
      },
    });
    const connection = await manager.save(user, "p", { accessToken: "fake-user" });
    const [page] = await provider.pages(connection);
    expect(await (await page.fetch("/v24.0/111/feed", { method: "POST" })).json()).toEqual({ token: "fake-page" });
    expect(hits).toHaveLength(0);
  });
});
