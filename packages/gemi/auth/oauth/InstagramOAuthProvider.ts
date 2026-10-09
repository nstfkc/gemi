import type { HttpRequest } from "../../http/HttpRequest";
import {
  INSTAGRAM_DEFAULT_SCOPES,
  INSTAGRAM_ENDPOINTS,
  type InstagramEndpoints,
  InstagramApiError,
  type InstagramProfile,
  exchangeInstagramCode,
  fetchInstagramProfile,
} from "./instagram";
import {
  type OAuthAuthorizationContext,
  OAuthCallbackError,
  OAuthProvider,
  type OAuthProfile,
} from "./OAuthProvider";

export interface InstagramOAuthProviderConfig extends InstagramEndpoints {
  /** The Instagram app id. Default `process.env.INSTAGRAM_CLIENT_ID`. */
  clientId: string;
  /** The Instagram app secret. Default `process.env.INSTAGRAM_CLIENT_SECRET`. */
  clientSecret: string;
  /** Default `["instagram_business_basic"]`, which is all sign-in needs. */
  scopes: string[];
  /**
   * The callback path, on `HOST_NAME`: the `redirect_uri` of both the
   * authorization URL and the code exchange. Default `/auth/oauth/instagram/callback`.
   */
  redirectPath: string;
  /** Extra authorization URL parameters, e.g. `{ enable_fb_login: "false" }` or `{ force_reauth: "true" }`. */
  authorizationParams: Record<string, string>;
}

/**
 * "Sign in with Instagram", through the Instagram API with Instagram Login.
 * Only Instagram professional accounts (business or creator) can sign in.
 *
 * ```ts
 * oauthProviders: { instagram: new InstagramOAuthProvider() }
 * ```
 *
 * The account's identity (`providerId`) is its Instagram account id
 * (`user_id`), the same id `InstagramConnectionProvider` stores as
 * `providerAccountId`. **Instagram returns no email**, so this provider sets
 * `createUsersWithoutEmail`: a first sign-in creates a user with no email,
 * linked by its `SocialAccount`, and `auth.oauthCompleteProfilePath` can send
 * such users to a page that asks for one. Turn it off
 * (`provider.createUsersWithoutEmail = false`) to let only users who linked
 * Instagram to an existing account sign in with it.
 */
export class InstagramOAuthProvider extends OAuthProvider {
  override createUsersWithoutEmail = true;
  // Instagram never returns an email, so there is nothing to link by.
  override linkByEmail = false;

  config: InstagramOAuthProviderConfig;

  constructor(config: Partial<InstagramOAuthProviderConfig> = {}) {
    super();
    this.config = {
      clientId: process.env.INSTAGRAM_CLIENT_ID ?? "",
      clientSecret: process.env.INSTAGRAM_CLIENT_SECRET ?? "",
      scopes: INSTAGRAM_DEFAULT_SCOPES,
      redirectPath: "/auth/oauth/instagram/callback",
      authorizationParams: {},
      ...config,
    };
  }

  /** `HOST_NAME` + `redirectPath`, the same for the authorization and the exchange. */
  redirectUri() {
    return `${process.env.HOST_NAME ?? ""}${this.config.redirectPath}`;
  }

  getRedirectUrl(_req?: HttpRequest, ctx?: OAuthAuthorizationContext) {
    const url = new URL(this.config.authorizeUrl ?? INSTAGRAM_ENDPOINTS.authorizeUrl);
    const params: Record<string, string> = {
      ...this.config.authorizationParams,
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: this.config.scopes.join(","),
    };
    // No PKCE: Instagram's authorize endpoint does not document it. The state
    // still binds the round trip to this browser.
    if (ctx) params.state = ctx.state;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async onCallback(req: HttpRequest): Promise<OAuthProfile> {
    const code = req.search.get("code");
    if (!code) throw new OAuthCallbackError("missing_code");

    let profile: InstagramProfile;
    try {
      // The short-lived token is enough for `/me`; sign-in keeps no token.
      const token = await exchangeInstagramCode({
        code,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        redirectUri: this.redirectUri(),
        tokenUrl: this.config.tokenUrl,
      });
      profile = await fetchInstagramProfile({
        accessToken: token.accessToken,
        graphUrl: this.config.graphUrl,
        graphApiVersion: this.config.graphApiVersion,
        fields: ["user_id", "username", "name"],
      });
    } catch (error) {
      if (error instanceof InstagramApiError) {
        console.error(`Instagram OAuth error: ${error.message}`);
        throw new OAuthCallbackError("exchange_failed");
      }
      throw error;
    }

    return {
      providerId: profile.user_id,
      username: profile.username,
      name: profile.name || profile.username,
    };
  }
}
