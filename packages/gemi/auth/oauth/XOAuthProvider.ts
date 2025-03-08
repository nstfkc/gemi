import { TOAuth2Scope, TwitterApi } from "twitter-api-v2";
import { Redirect } from "../../facades";
import { HttpRequest } from "../../http/HttpRequest";
import { OAuthProvider } from "./OAuthProvider";

type Config = {
  clientId: string;
  scope: TOAuth2Scope[];
  clientSecret: string;
  redirectPath: string;
};

type OAuthState = {
  state: string;
  codeVerifier: string;
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
  // Using a Map to store state and codeVerifier for different OAuth flows
  private oauthStates: Map<string, OAuthState> = new Map();

  constructor(config: Partial<Config> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
    this.client = new TwitterApi({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
  }

  getRedirectUrl() {
    const { url, codeVerifier, state } = this.client.generateOAuth2AuthLink(
      `${process.env.HOST_NAME}${this.config.redirectPath}`,
      { scope: this.config.scope },
    );

    // Store state and codeVerifier in a map with state as the key
    this.oauthStates.set(state, { state, codeVerifier });

    Redirect.to(url as never);
    return url;
  }

  async onCallback(req: HttpRequest) {
    const code = req.search.get("code")!;
    const state = req.search.get("state")!;

    // Retrieve the stored codeVerifier using the state from the callback
    const oauthState = this.oauthStates.get(state);

    if (!oauthState) {
      throw new Error("Invalid or expired OAuth state");
    }

    const result = await this.client.loginWithOAuth2({
      code,
      codeVerifier: oauthState.codeVerifier,
      redirectUri: `${process.env.HOST_NAME}${this.config.redirectPath}`,
    });

    // Clean up the stored state after use
    this.oauthStates.delete(state);

    const { data } = await result.client.v2.me({
      "user.fields": ["name", "username", "entities"],
    });

    const { name, email, id = "", username } = data ?? ({} as any);
    return { name, email, username, providerId: id };
  }
}
