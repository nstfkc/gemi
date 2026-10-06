import { type TOAuth2Scope, TwitterApi } from "twitter-api-v2";
import { HttpRequest } from "../../http/HttpRequest";
import {
  type OAuthAuthorizationContext,
  type OAuthCallbackContext,
  OAuthCallbackError,
  OAuthProvider,
  type OAuthProfile,
} from "./OAuthProvider";

type Config = {
  clientId: string;
  scope: TOAuth2Scope[];
  clientSecret: string;
  redirectPath: string;
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
    return `${process.env.HOST_NAME ?? ""}${this.config.redirectPath}`;
  }

  /**
   * Built here rather than with `generateOAuth2AuthLink`, which mints its own
   * state and verifier: the round trip's are gemi's, kept in a cookie so that
   * any process can finish it. They used to be kept in a `Map` on this
   * instance, which a callback reaching another process could not find.
   */
  getRedirectUrl(_req?: HttpRequest, ctx?: OAuthAuthorizationContext) {
    if (!ctx) {
      throw new Error("XOAuthProvider needs the state and PKCE challenge gemi passes.");
    }
    const url = new URL("https://x.com/i/oauth2/authorize");
    const params = {
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri(),
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

    let result: Awaited<ReturnType<TwitterApi["loginWithOAuth2"]>>;
    try {
      result = await this.client.loginWithOAuth2({
        code,
        codeVerifier: ctx.codeVerifier,
        redirectUri: this.redirectUri(),
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
