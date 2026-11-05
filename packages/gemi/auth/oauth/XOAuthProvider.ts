import { type TOAuth2Scope, TwitterApi } from "twitter-api-v2";
import { HttpRequest } from "../../http/HttpRequest";
import {
  type OAuthAuthorizationContext,
  type OAuthCallbackContext,
  OAuthCallbackError,
  OAuthProvider,
  type OAuthProfile,
} from "./OAuthProvider";
import { configuredAppOrigin } from "../../utils/appOrigin";
import { type OAuthClientResolver, type ResolvedOAuthClient, resolveOAuthClient } from "./client";

type Config = {
  clientId: string;
  scope: TOAuth2Scope[];
  clientSecret: string;
  redirectPath: string;
  /**
   * The client and callback origin per request (#1140):
   * `({ req, origin }) => ({ clientId, clientSecret, origin })`. What it
   * leaves out comes from the options above; `null` turns the provider off
   * for the request.
   */
  resolve?: OAuthClientResolver;
};

const defaultConfig: Config = {
  clientId: process.env.X_CLIENT_ID!,
  clientSecret: process.env.X_SECRET!,
  redirectPath: "/auth/oauth/x/callback",
  scope: ["tweet.read", "users.read", "offline.access"],
};

export class XOAuthProvider extends OAuthProvider {
  config: Config;
  client: TwitterApi;

  constructor(config: Partial<Config> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
    this.client = new TwitterApi({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
  }

  redirectUri() {
    return `${configuredAppOrigin() ?? ""}${this.config.redirectPath}`;
  }

  protected override clientFor(req: HttpRequest<any, any> | null) {
    return resolveOAuthClient(this, req, {
      name: "XOAuthProvider",
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

  /**
   * Built here rather than with `generateOAuth2AuthLink`, which mints its own
   * state and verifier: the round trip's are gemi's, kept in a cookie so that
   * any process can finish it. They used to be kept in a `Map` on this
   * instance, which a callback reaching another process could not find.
   */
  getRedirectUrl(req?: HttpRequest, ctx?: OAuthAuthorizationContext): string | Promise<string> {
    if (!ctx) {
      throw new Error("XOAuthProvider needs the state and PKCE challenge gemi passes.");
    }
    if (!this.config.resolve) return this.authorizationUrl(this.staticClient(), ctx);
    return this.clientFor(req ?? null).then((client) => {
      if (!client) throw new Error("XOAuthProvider is not offered on this request.");
      return this.authorizationUrl(client, ctx);
    });
  }

  private authorizationUrl(client: ResolvedOAuthClient, ctx: OAuthAuthorizationContext) {
    const url = new URL("https://x.com/i/oauth2/authorize");
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      state: ctx.state,
      code_challenge: ctx.codeChallenge,
      code_challenge_method: ctx.codeChallengeMethod,
      scope: this.config.scope.join(" "),
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async onCallback(req: HttpRequest, ctx?: OAuthCallbackContext): Promise<OAuthProfile> {
    const code = req.search.get("code");
    if (!code) throw new OAuthCallbackError("missing_code");
    if (!ctx?.codeVerifier) throw new OAuthCallbackError("invalid_state");
    const client = this.config.resolve ? await this.clientFor(req) : this.staticClient();
    if (!client) throw new OAuthCallbackError("unknown_provider");
    // The static client is built once; a resolved one per request.
    const api = this.config.resolve
      ? new TwitterApi({ clientId: client.clientId, clientSecret: client.clientSecret })
      : this.client;

    let result: Awaited<ReturnType<TwitterApi["loginWithOAuth2"]>>;
    try {
      result = await api.loginWithOAuth2({
        code,
        codeVerifier: ctx.codeVerifier,
        redirectUri: client.redirectUri,
      });
    } catch (error) {
      console.error("X OAuth error: token exchange failed", error);
      throw new OAuthCallbackError("exchange_failed");
    }

    const { data } = await result.client.v2.me({
      "user.fields": ["name", "username", "entities"],
    });

    const { name, email, id = "", username } = data ?? ({} as any);
    return { name, email, username, providerId: id };
  }
}
