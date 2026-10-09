import { OAuthConnectionError } from "./errors";
import { type OAuthTokenSet, OAuthConnectionProvider } from "./OAuthConnectionProvider";
import {
  INSTAGRAM_ENDPOINTS,
  type InstagramEndpoints,
  InstagramApiError,
  exchangeInstagramCode,
  exchangeInstagramLongLivedToken,
  fetchInstagramProfile,
  refreshInstagramToken,
} from "../oauth/instagram";

export interface InstagramConnectionProviderConfig extends InstagramEndpoints {
  /** The Instagram app id. Default `process.env.INSTAGRAM_CLIENT_ID`. */
  clientId?: string;
  /** The Instagram app secret. Default `process.env.INSTAGRAM_CLIENT_SECRET`. */
  clientSecret?: string;
  /**
   * Default `["instagram_business_basic", "instagram_business_content_publish"]`.
   * Keep `instagram_business_basic`: without it Instagram refuses refreshes.
   */
  scopes?: string[];
  /**
   * One user may connect several Instagram accounts, told apart by the
   * Instagram account id. Default `false`. See `OAuthConnectionProviderConfig.multiple`.
   */
  multiple?: boolean;
  /**
   * Extra authorization URL parameters: `{ force_reauth: "true" }` asks for
   * the Instagram login again (to connect a second account while the browser
   * is signed into the first), `{ enable_fb_login: "false" }` hides the
   * Facebook login option.
   */
  authorizationParams?: Record<string, string>;
  /** Default `${HOST_NAME}/auth/connections/<name>/callback`. Register it with Meta. */
  redirectUri?: string;
  /**
   * Refresh this long before the token expires. Default 10 days: every use of
   * the connection in the last 10 of its 60 days renews it. A connection not
   * used for 60 days expires; renew idle ones from a scheduled job
   * (`connection.refresh()`).
   */
  refreshLeewaySeconds?: number;
}

/** Instagram refuses to refresh a token younger than this. */
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * An Instagram professional account (business or creator), connected through
 * the Instagram API with Instagram Login, to read it and publish to it:
 *
 * ```ts
 * connections: {
 *   instagram: new InstagramConnectionProvider({
 *     scopes: ["instagram_business_basic", "instagram_business_content_publish"],
 *     multiple: true,
 *   }),
 * }
 * ```
 *
 * The code exchange also trades the short-lived token for a long-lived one
 * (60 days) and reads `/me`; `providerAccountId` is the Instagram account id
 * (`user_id`, the `<IG_ID>` of `/<IG_ID>/media`), and `onConnected` gets the
 * profile. Refreshing renews the access token itself (`ig_refresh_token`):
 * there is no refresh token. Instagram has no revocation endpoint, so
 * `revoke()` throws `revoke_unsupported`; use `disconnect()`.
 *
 * `connection.fetch` sends the token as `Authorization: Bearer`, to
 * `https://graph.instagram.com` only.
 */
export class InstagramConnectionProvider extends OAuthConnectionProvider {
  readonly instagram: Required<Omit<InstagramEndpoints, "graphApiVersion">> & Pick<InstagramEndpoints, "graphApiVersion">;

  constructor(config: InstagramConnectionProviderConfig = {}) {
    const endpoints = {
      authorizeUrl: config.authorizeUrl ?? INSTAGRAM_ENDPOINTS.authorizeUrl,
      tokenUrl: config.tokenUrl ?? INSTAGRAM_ENDPOINTS.tokenUrl,
      graphUrl: config.graphUrl ?? INSTAGRAM_ENDPOINTS.graphUrl,
      graphApiVersion: config.graphApiVersion,
    };
    super({
      authorizeUrl: endpoints.authorizeUrl,
      tokenUrl: endpoints.tokenUrl,
      clientId: config.clientId ?? process.env.INSTAGRAM_CLIENT_ID ?? "",
      clientSecret: config.clientSecret ?? process.env.INSTAGRAM_CLIENT_SECRET ?? "",
      scopes: config.scopes ?? ["instagram_business_basic", "instagram_business_content_publish"],
      scopeSeparator: ",",
      // Instagram's authorize endpoint does not document PKCE.
      pkce: false,
      authorizationParams: config.authorizationParams ?? {},
      redirectUri: config.redirectUri,
      apiBaseUrl: endpoints.graphUrl,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 10 * 24 * 60 * 60,
      multiple: config.multiple ?? false,
      refreshStrategy: async (current) => {
        // Too young to refresh: Instagram would refuse, and its refusal
        // would read as a revoked grant. The token is still good.
        if (Date.now() - current.issuedAt.getTime() < MIN_REFRESH_AGE_MS) return null;
        const token = await instagramCall("refresh_failed", () =>
          refreshInstagramToken({ accessToken: current.accessToken, graphUrl: endpoints.graphUrl }),
        );
        return {
          accessToken: token.accessToken,
          refreshToken: null,
          tokenType: token.tokenType,
          expiresAt: token.expiresIn === null ? null : new Date(Date.now() + token.expiresIn * 1000),
          scopes: current.scopes,
          providerAccountId: current.providerAccountId,
        };
      },
    });
    this.instagram = endpoints;
  }

  /**
   * The code for a short-lived token, that for a long-lived one, and `/me`
   * for the account.
   */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const short = await instagramCall("exchange_failed", () =>
      exchangeInstagramCode({
        code: args.code,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        redirectUri: args.redirectUri,
        tokenUrl: this.instagram.tokenUrl,
      }),
    );
    const long = await instagramCall("exchange_failed", () =>
      exchangeInstagramLongLivedToken({
        accessToken: short.accessToken,
        clientSecret: this.config.clientSecret,
        graphUrl: this.instagram.graphUrl,
      }),
    );
    const profile = await instagramCall("exchange_failed", () =>
      fetchInstagramProfile({
        accessToken: long.accessToken,
        graphUrl: this.instagram.graphUrl,
        graphApiVersion: this.instagram.graphApiVersion,
      }),
    );
    return {
      accessToken: long.accessToken,
      refreshToken: null,
      tokenType: long.tokenType,
      expiresAt: long.expiresIn === null ? null : new Date(Date.now() + long.expiresIn * 1000),
      scopes: short.permissions ?? this.config.scopes,
      providerAccountId: profile.user_id,
      profile: { ...profile },
    };
  }

  /** Instagram has no refresh token; the connection renews through `refreshStrategy`. */
  override refresh(): Promise<OAuthTokenSet> {
    return Promise.reject(
      new OAuthConnectionError("refresh_failed", "Instagram connections renew the access token itself; call connection.refresh()."),
    );
  }
}

/** An `InstagramApiError` as the `OAuthConnectionError` the connection machinery classifies. */
async function instagramCall<T>(failure: "exchange_failed" | "refresh_failed", fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InstagramApiError) {
      throw new OAuthConnectionError(failure, error.message, {
        cause: error,
        // A 200 without a token is Instagram misbehaving, not a refusal.
        status: error.status === 200 ? 502 : error.status,
      });
    }
    throw error;
  }
}
