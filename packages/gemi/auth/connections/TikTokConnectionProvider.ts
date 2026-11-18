import type { ProviderConnection } from "./ConnectionManager";
import { OAuthConnectionError } from "./errors";
import { type OAuthTokenSet, OAuthConnectionProvider } from "./OAuthConnectionProvider";
import {
  type ConnectedAccountProfile,
  type SocialConnectionProviderConfig,
  assertConnectionOf,
  bearerGet,
  idOrNull,
  missingAccountId,
  requestJson,
  stringOrNull,
} from "./social";

/** The TikTok account, from `GET /v2/user/info/`. */
export type TikTokProfile = ConnectedAccountProfile & {
  /** The `open_id`: the user's id for this app. */
  id: string;
  /** The `display_name`. */
  name: string | null;
  /** The `username`: only with `user.info.profile`. */
  username: string | null;
  /** The `union_id`: the same user across apps of one developer. */
  unionId: string | null;
};

export interface TikTokConnectionProviderConfig extends SocialConnectionProviderConfig {
  /** The app's client key. Default `process.env.TIKTOK_CLIENT_KEY`. Same as `clientId`. */
  clientKey?: string;
}

/**
 * `user.info.basic` to read the account, `video.publish` to post directly
 * and `video.upload` to send drafts to the user's TikTok inbox.
 */
export const TIKTOK_DEFAULT_SCOPES = ["user.info.basic", "video.publish", "video.upload"];

/**
 * A TikTok account, connected with Login Kit for Web (OAuth v2) to post
 * videos and photos through the Content Posting API:
 *
 * ```ts
 * connections: {
 *   tiktok: new TikTokConnectionProvider({ multiple: true }),
 * }
 * ```
 *
 * TikTok calls the client id `client_key`, joins scopes with commas, and
 * documents no PKCE for web apps. Access tokens last two hours; refresh
 * tokens rotate on every refresh and last 180 days. `providerAccountId` is
 * the `open_id`, and `onConnected` gets a `TikTokProfile`. `revoke()` revokes
 * the access token at `/v2/oauth/revoke/`, which ends the grant.
 */
export class TikTokConnectionProvider extends OAuthConnectionProvider {
  constructor(config: TikTokConnectionProviderConfig = {}) {
    super({
      authorizeUrl: config.authorizeUrl ?? "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: config.tokenUrl ?? "https://open.tiktokapis.com/v2/oauth/token/",
      revokeUrl: config.revokeUrl ?? "https://open.tiktokapis.com/v2/oauth/revoke/",
      apiBaseUrl: config.apiBaseUrl ?? "https://open.tiktokapis.com",
      clientId: config.clientKey ?? config.clientId ?? process.env.TIKTOK_CLIENT_KEY ?? "",
      clientSecret: config.clientSecret ?? process.env.TIKTOK_CLIENT_SECRET ?? "",
      clientIdParam: "client_key",
      scopes: config.scopes ?? TIKTOK_DEFAULT_SCOPES,
      scopeSeparator: ",",
      pkce: false,
      revokeTokenHint: "access_token",
      authorizationParams: config.authorizationParams ?? {},
      redirectUri: config.redirectUri,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 5 * 60,
      multiple: config.multiple ?? false,
    });
  }

  /** The code for tokens (`open_id` names the account), then the account. */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const tokens = await super.exchangeCode(args);
    const profile = parseUser(
      await requestJson("TikTok user info", "exchange_failed", () =>
        bearerGet(this.userInfoUrl(tokens.scopes), tokens.accessToken),
      ),
      "exchange_failed",
    );
    return { ...tokens, providerAccountId: profile.id, profile: { ...profile } };
  }

  /** The connected account as it is now. Needs `user.info.basic` (and `user.info.profile` for `username`). */
  async profile(connection: ProviderConnection): Promise<TikTokProfile> {
    assertConnectionOf(connection, this, "TikTokConnectionProvider.profile()");
    return parseUser(
      await requestJson("TikTok user info", "request_failed", () =>
        connection.fetch(this.userInfoUrl([...connection.scopes])),
      ),
      "request_failed",
    );
  }

  private userInfoUrl(scopes: string[]): URL {
    const url = new URL("/v2/user/info/", this.config.apiBaseUrl);
    const fields = ["open_id", "union_id", "avatar_url", "display_name"];
    // Asking for a field the token has no scope for fails the whole call.
    if (scopes.includes("user.info.profile")) fields.push("username");
    url.searchParams.set("fields", fields.join(","));
    return url;
  }
}

function parseUser(payload: Record<string, unknown>, failure: "exchange_failed" | "request_failed"): TikTokProfile {
  const error = (payload.error ?? {}) as Record<string, unknown>;
  if (typeof error.code === "string" && error.code !== "ok") {
    throw new OAuthConnectionError(failure, `TikTok refused the user info request (${safeCode(error.code)}).`, {
      status: 400,
    });
  }
  const user = ((payload.data ?? {}) as Record<string, unknown>).user as Record<string, unknown> | undefined;
  const id = idOrNull(user?.open_id);
  if (!user || !id) throw missingAccountId("TikTok");
  return {
    id,
    name: stringOrNull(user.display_name),
    username: stringOrNull(user.username),
    avatarUrl: stringOrNull(user.avatar_url),
    unionId: stringOrNull(user.union_id),
  };
}

function safeCode(code: string): string {
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "error";
}
