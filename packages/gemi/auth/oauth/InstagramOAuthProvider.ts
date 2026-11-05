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
import { configuredAppOrigin } from "../../utils/appOrigin";
import { type OAuthClientResolver, type ResolvedOAuthClient, resolveOAuthClient } from "./client";

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
  /**
   * The app and callback origin per request (#1140):
   * `({ req, origin }) => ({ clientId, clientSecret, origin })`. What it
   * leaves out comes from the options above; `null` turns the provider off
   * for the request.
   */
  resolve?: OAuthClientResolver;
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

  /** The app origin (`HOST_NAME`, else `APP_URL`) + `redirectPath`, the same for the authorization and the exchange. */
  redirectUri() {
    return `${configuredAppOrigin() ?? ""}${this.config.redirectPath}`;
  }

  protected override clientFor(req: HttpRequest<any, any> | null) {
    return resolveOAuthClient(this, req, {
      name: "InstagramOAuthProvider",
      resolve: this.config.resolve,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectPath: this.config.redirectPath,
      staticRedirectUri: () => this.redirectUri(),
      staticOrigin: () => configuredAppOrigin() ?? "",
    });
  }

  private staticClient(): ResolvedOAuthClient {
    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: this.redirectUri(),
    };
  }

  getRedirectUrl(req?: HttpRequest, ctx?: OAuthAuthorizationContext): string | Promise<string> {
    if (!this.config.resolve) return this.authorizationUrl(this.staticClient(), ctx);
    return this.clientFor(req ?? null).then((client) => {
      if (!client) throw new Error("InstagramOAuthProvider is not offered on this request.");
      return this.authorizationUrl(client, ctx);
    });
  }

  private authorizationUrl(client: ResolvedOAuthClient, ctx?: OAuthAuthorizationContext) {
    const url = new URL(this.config.authorizeUrl ?? INSTAGRAM_ENDPOINTS.authorizeUrl);
    const params: Record<string, string> = {
      ...this.config.authorizationParams,
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
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
    const client = this.config.resolve ? await this.clientFor(req) : this.staticClient();
    if (!client) throw new OAuthCallbackError("unknown_provider");

    let profile: InstagramProfile;
    try {
      // The short-lived token is enough for `/me`; sign-in keeps no token.
      const token = await exchangeInstagramCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: client.redirectUri,
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
