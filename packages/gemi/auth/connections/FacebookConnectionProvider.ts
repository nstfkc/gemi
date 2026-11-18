import type { ProviderConnection } from "./ConnectionManager";
import { OAuthConnectionError } from "./errors";
import { isInstagramTokenRejected } from "./InstagramConnectionProvider";
import { type OAuthTokenSet, OAuthConnectionProvider } from "./OAuthConnectionProvider";
import {
  type ConnectedAccountProfile,
  type SocialConnectionProviderConfig,
  assertConnectionOf,
  idOrNull,
  missingAccountId,
  requestJson,
  stringOrNull,
} from "./social";

/** A Facebook Page, as `onConnected`'s profile lists it: never with its token. */
export type FacebookPageSummary = {
  id: string;
  name: string | null;
  category: string | null;
  /** What the user may do on the Page: `CREATE_CONTENT`, `MANAGE`, `MODERATE`, … */
  tasks: string[];
  avatarUrl: string | null;
};

/** The Facebook user who connected, from `GET /me`, and the Pages they granted. */
export type FacebookProfile = ConnectedAccountProfile & {
  /** The app-scoped user id. */
  id: string;
  /** Facebook has no public handle: always `null`. */
  username: string | null;
  /** The Pages the user granted the app, without tokens. Use `provider.pages(connection)` for those. */
  pages: FacebookPageSummary[];
};

export interface FacebookConnectionProviderConfig extends SocialConnectionProviderConfig {
  /**
   * The Facebook Login for Business configuration id. When set it is sent as
   * `config_id` and `scopes` are left off the authorization URL: the
   * configuration names the permissions. Default `process.env.FACEBOOK_CONFIG_ID`.
   */
  configId?: string;
  /**
   * The Graph API version for every call, such as `"v24.0"`. Default none: the
   * unversioned paths, which use the app's default version.
   */
  graphApiVersion?: string;
  /** Override the login dialog origin (tests). Default `https://www.facebook.com`. */
  dialogUrl?: string;
}

/** List the user's Pages, read their engagement, and post to them. */
export const FACEBOOK_DEFAULT_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

/**
 * A Facebook user's grant to manage their Pages, connected with Facebook
 * Login for Business, to post to those Pages:
 *
 * ```ts
 * connections: {
 *   facebook: new FacebookConnectionProvider(),
 * }
 * ```
 *
 * The code exchange trades the short-lived user token for a long-lived one
 * (about 60 days) and reads `/me`, the granted permissions and the Pages.
 * Facebook issues no refresh token: once the user token expires (or the user
 * removes the app), the connection reads `needs_reconnect`. A Page is posted
 * to with its own Page token, which `pages(connection)` reads fresh each
 * time; `page.fetch` spends it on the Graph API only. `revoke()` removes the
 * app's permissions (`DELETE /me/permissions`).
 *
 * `connection.fetch` sends the token as the `access_token` query parameter,
 * to `https://graph.facebook.com` only, and treats a 400 with OAuthException
 * code 190 like a 401.
 */
export class FacebookConnectionProvider extends OAuthConnectionProvider {
  readonly configId: string | undefined;
  readonly graphApiVersion: string | undefined;

  constructor(config: FacebookConnectionProviderConfig = {}) {
    const version = config.graphApiVersion?.replace(/^\/+|\/+$/g, "");
    const prefix = version ? `/${version}` : "";
    const graph = config.apiBaseUrl ?? "https://graph.facebook.com";
    super({
      authorizeUrl: config.authorizeUrl ?? `${config.dialogUrl ?? "https://www.facebook.com"}${prefix}/dialog/oauth`,
      tokenUrl: config.tokenUrl ?? `${graph}${prefix}/oauth/access_token`,
      revokeUrl: config.revokeUrl ?? `${graph}${prefix}/me/permissions`,
      apiBaseUrl: graph,
      clientId: config.clientId ?? process.env.FACEBOOK_CLIENT_ID ?? "",
      clientSecret: config.clientSecret ?? process.env.FACEBOOK_CLIENT_SECRET ?? "",
      scopes: config.scopes ?? FACEBOOK_DEFAULT_SCOPES,
      scopeSeparator: ",",
      pkce: false,
      authorizationParams: config.authorizationParams ?? {},
      redirectUri: config.redirectUri,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 60,
      multiple: config.multiple ?? false,
      tokenPlacement: "query",
      revokeTokenHint: "access_token",
      isTokenRejected: isInstagramTokenRejected,
      refreshStrategy: async (current) => {
        // No refresh token and no server-side renewal: a refused token means
        // the grant is gone; an expiring one is used until it is refused.
        if (current.reason === "rejected") {
          throw new OAuthConnectionError("refresh_failed", "Facebook refused the access token (OAuthException 190).", {
            status: 401,
          });
        }
        return null;
      },
    });
    this.configId = config.configId ?? (process.env.FACEBOOK_CONFIG_ID || undefined);
    this.graphApiVersion = version || undefined;
  }

  /** With a `configId`, `config_id` takes the place of `scope`. */
  override authorizationUrl(args: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(super.authorizationUrl(args));
    if (this.configId) {
      url.searchParams.delete("scope");
      url.searchParams.set("config_id", this.configId);
    }
    return url.toString();
  }

  /**
   * The code for a short-lived user token, that for a long-lived one, then
   * the user, the permissions they granted and their Pages.
   */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const short = await this.tokenCall({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: args.redirectUri,
      code: args.code,
    });
    const long = await this.tokenCall({
      grant_type: "fb_exchange_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: short.accessToken,
    });
    const token = long.accessToken;
    const me = await requestJson("Facebook /me", "exchange_failed", () =>
      fetch(this.graphUrl(this.path("/me", { fields: "id,name,picture{url}" }), token), { redirect: "error" }),
    );
    const id = idOrNull(me.id);
    if (!id) throw missingAccountId("Facebook");
    const permissions = await requestJson("Facebook /me/permissions", "exchange_failed", () =>
      fetch(this.graphUrl(this.path("/me/permissions"), token), { redirect: "error" }),
    );
    const granted = ((Array.isArray(permissions.data) ? permissions.data : []) as Record<string, unknown>[])
      .filter((entry) => entry.status === "granted" && typeof entry.permission === "string")
      .map((entry) => entry.permission as string);
    const pages = await this.listPages((url) => fetch(this.graphUrl(url, token), { redirect: "error" }), "exchange_failed");

    const profile: FacebookProfile = {
      id,
      name: stringOrNull(me.name),
      username: null,
      avatarUrl: pictureUrl(me.picture),
      pages: pages.map(({ accessToken: _token, ...summary }) => summary),
    };
    return {
      accessToken: token,
      refreshToken: null,
      tokenType: long.tokenType,
      expiresAt: long.expiresIn === null ? null : new Date(Date.now() + long.expiresIn * 1000),
      scopes: granted.length > 0 ? granted : this.config.scopes,
      providerAccountId: id,
      profile: { ...profile },
    };
  }

  /** Facebook issues no refresh token; see `refreshStrategy`. */
  override refresh(): Promise<OAuthTokenSet> {
    return Promise.reject(
      new OAuthConnectionError("refresh_failed", "Facebook issues no refresh token; reconnect the account."),
    );
  }

  /** Removes every permission the user granted the app: `DELETE /me/permissions`. */
  override async revoke(token: string): Promise<void> {
    const url = new URL(this.config.revokeUrl as string);
    url.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await fetch(url, { method: "DELETE", redirect: "error" });
    } catch (cause) {
      throw new OAuthConnectionError("revoke_failed", "The revocation request failed.", { cause });
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new OAuthConnectionError("revoke_failed", `Facebook refused the revocation (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
  }

  /** The connected user as they are now, and their Pages (without tokens). */
  async profile(connection: ProviderConnection): Promise<FacebookProfile> {
    assertConnectionOf(connection, this, "FacebookConnectionProvider.profile()");
    const me = await requestJson("Facebook /me", "request_failed", () =>
      connection.fetch(this.path("/me", { fields: "id,name,picture{url}" })),
    );
    const id = idOrNull(me.id);
    if (!id) throw missingAccountId("Facebook");
    const pages = await this.pages(connection);
    return {
      id,
      name: stringOrNull(me.name),
      username: null,
      avatarUrl: pictureUrl(me.picture),
      pages: pages.map((page) => page.toJSON()),
    };
  }

  /**
   * The Pages the user granted the app (`GET /me/accounts`, every page of
   * results), each with its own Page token. Needs `pages_show_list`; posting
   * needs `pages_manage_posts` and the `CREATE_CONTENT` task on the Page.
   */
  async pages(connection: ProviderConnection): Promise<FacebookPage[]> {
    assertConnectionOf(connection, this, "FacebookConnectionProvider.pages()");
    const pages = await this.listPages((url) => connection.fetch(url), "request_failed");
    return pages.map((page) => new FacebookPage(connection, page));
  }

  /** `path` under the configured Graph API version, with `params`. */
  path(path: string, params: Record<string, string> = {}): string {
    const prefix = this.graphApiVersion ? `/${this.graphApiVersion}` : "";
    const url = new URL(`${prefix}${path}`, this.config.apiBaseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return `${url.pathname}${url.search}`;
  }

  /** A path from `path()` (or a paging URL) with `token`, on the Graph API's origin only. */
  private graphUrl(pathOrUrl: string, token: string): URL {
    const url = new URL(pathOrUrl, this.config.apiBaseUrl);
    if (url.origin !== new URL(this.config.apiBaseUrl).origin) {
      throw new OAuthConnectionError("forbidden_url", "Facebook paged to another origin.");
    }
    url.searchParams.set("access_token", token);
    return url;
  }

  private async listPages(
    get: (url: string) => Promise<Response>,
    failure: "exchange_failed" | "request_failed",
  ): Promise<(FacebookPageSummary & { accessToken: string | null })[]> {
    const pages: (FacebookPageSummary & { accessToken: string | null })[] = [];
    let next: string | null = this.path("/me/accounts", {
      fields: "id,name,category,tasks,access_token,picture{url}",
      limit: "100",
    });
    for (let round = 0; next !== null && round < 20; round++) {
      const url: string = next;
      const payload = await requestJson("Facebook /me/accounts", failure, () => get(url));
      for (const entry of (Array.isArray(payload.data) ? payload.data : []) as Record<string, unknown>[]) {
        const id = idOrNull(entry.id);
        if (!id) continue;
        pages.push({
          id,
          name: stringOrNull(entry.name),
          category: stringOrNull(entry.category),
          tasks: Array.isArray(entry.tasks) ? entry.tasks.filter((task): task is string => typeof task === "string") : [],
          avatarUrl: pictureUrl(entry.picture),
          accessToken: stringOrNull(entry.access_token),
        });
      }
      const paging = (payload.paging ?? {}) as { next?: unknown };
      next = typeof paging.next === "string" ? paging.next : null;
    }
    return pages;
  }

  private async tokenCall(params: Record<string, string>): Promise<{
    accessToken: string;
    tokenType: string | null;
    expiresIn: number | null;
  }> {
    const url = new URL(this.config.tokenUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const payload = await requestJson("Facebook token", "exchange_failed", () =>
      fetch(url, { headers: { Accept: "application/json" }, redirect: "error" }),
    );
    const accessToken = stringOrNull(payload.access_token);
    if (!accessToken) {
      throw new OAuthConnectionError("exchange_failed", "Facebook answered the code exchange without a token.", {
        status: 502,
      });
    }
    const expiresIn = Number(payload.expires_in);
    return {
      accessToken,
      tokenType: stringOrNull(payload.token_type),
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
    };
  }
}

/**
 * A Page the user manages, with its own Page token. Never exposes the token
 * as a property, and serialises (`toJSON`) without it.
 */
export class FacebookPage {
  readonly id: string;
  readonly name: string | null;
  readonly category: string | null;
  readonly tasks: readonly string[];
  readonly avatarUrl: string | null;
  readonly #token: string | null;

  constructor(
    private readonly connection: ProviderConnection,
    page: FacebookPageSummary & { accessToken: string | null },
  ) {
    this.id = page.id;
    this.name = page.name;
    this.category = page.category;
    this.tasks = page.tasks;
    this.avatarUrl = page.avatarUrl;
    this.#token = page.accessToken;
  }

  /** Whether the user may post to the Page (the `CREATE_CONTENT` task). */
  get canPost(): boolean {
    return this.tasks.includes("CREATE_CONTENT");
  }

  /** The Page token, for an SDK that wants it. Prefer `fetch`. */
  accessToken(): string {
    if (this.#token === null) {
      throw new OAuthConnectionError("request_failed", `Facebook gave no Page token for Page ${this.id}.`);
    }
    return this.#token;
  }

  /**
   * `fetch` as the Page: the Page token goes as `access_token`, to the
   * Graph API's origin only (any other origin is refused), through
   * `Connections.fake` when faked. `page.fetch(`/${page.id}/feed`, { method: "POST", body })`.
   */
  fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    return this.connection.fetchWithToken(this.accessToken(), input, init);
  }

  toJSON(): FacebookPageSummary {
    return { id: this.id, name: this.name, category: this.category, tasks: [...this.tasks], avatarUrl: this.avatarUrl };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return { FacebookPage: this.toJSON() };
  }
}

function pictureUrl(picture: unknown): string | null {
  const data = (picture as { data?: { url?: unknown } } | undefined)?.data;
  return stringOrNull(data?.url);
}
