import type { ProviderConnection } from "./ConnectionManager";
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

/** The X account, from `GET /2/users/me`. */
export type XProfile = ConnectedAccountProfile & {
  /** The handle, without `@`. */
  username: string | null;
};

export type XConnectionProviderConfig = SocialConnectionProviderConfig;

/** What posting a post with media needs: `POST /2/tweets` wants `tweet.read` and `users.read` beside `tweet.write`. */
export const X_DEFAULT_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

/**
 * An X account, connected with OAuth 2.0 (authorization code + PKCE) to post
 * on its behalf:
 *
 * ```ts
 * connections: {
 *   x: new XConnectionProvider({ multiple: true }),
 * }
 * ```
 *
 * The app is a confidential client: the token, refresh and revocation
 * requests authenticate with HTTP Basic. Access tokens last two hours;
 * `offline.access` gets a refresh token, which X rotates on every refresh.
 * `providerAccountId` is the X user id, and `onConnected` gets an `XProfile`.
 */
export class XConnectionProvider extends OAuthConnectionProvider {
  constructor(config: XConnectionProviderConfig = {}) {
    super({
      authorizeUrl: config.authorizeUrl ?? "https://x.com/i/oauth2/authorize",
      tokenUrl: config.tokenUrl ?? "https://api.x.com/2/oauth2/token",
      revokeUrl: config.revokeUrl ?? "https://api.x.com/2/oauth2/revoke",
      apiBaseUrl: config.apiBaseUrl ?? "https://api.x.com",
      clientId: config.clientId ?? process.env.X_CLIENT_ID ?? "",
      clientSecret: config.clientSecret ?? process.env.X_CLIENT_SECRET ?? process.env.X_SECRET ?? "",
      scopes: config.scopes ?? X_DEFAULT_SCOPES,
      clientAuth: "basic",
      pkce: true,
      authorizationParams: config.authorizationParams ?? {},
      redirectUri: config.redirectUri,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 5 * 60,
      multiple: config.multiple ?? false,
    });
  }

  /** The code for tokens, then `/2/users/me` for the account. */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const tokens = await super.exchangeCode(args);
    const profile = parseXProfile(
      await requestJson("X profile", "exchange_failed", () => bearerGet(this.profileUrl(), tokens.accessToken)),
    );
    return { ...tokens, providerAccountId: profile.id, profile: { ...profile } };
  }

  /** The connected account as it is now. Needs `users.read`. */
  async profile(connection: ProviderConnection): Promise<XProfile> {
    assertConnectionOf(connection, this, "XConnectionProvider.profile()");
    return parseXProfile(await requestJson("X profile", "request_failed", () => connection.fetch(this.profileUrl())));
  }

  private profileUrl(): URL {
    const url = new URL("/2/users/me", this.config.apiBaseUrl);
    url.searchParams.set("user.fields", "profile_image_url");
    return url;
  }
}

function parseXProfile(payload: Record<string, unknown>): XProfile {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const id = idOrNull(data.id);
  if (!id) throw missingAccountId("X");
  return {
    id,
    name: stringOrNull(data.name),
    username: stringOrNull(data.username),
    avatarUrl: stringOrNull(data.profile_image_url),
  };
}
