import type { HttpRequest } from "../../http/HttpRequest";
import {
  type OAuthAuthorizationContext,
  type OAuthCallbackContext,
  OAuthCallbackError,
  OAuthProvider,
  type OAuthProfile,
} from "./OAuthProvider";

type Config = {
  clientId: string;
  scope: string;
  clientSecret: string;
  /**
   * The callback path, on `HOST_NAME`. Used for the `redirect_uri` of both the
   * authorization URL and the token exchange, which Google requires to match.
   */
  redirectPath: string;
  /**
   * Extra parameters for Google's authorization URL, such as
   * `{ prompt: "select_account" }` or `{ hd: "example.com" }`. They cannot
   * replace `state`, the PKCE challenge, `redirect_uri` or `client_id`.
   */
  authorizationParams: Record<string, string>;
};

const defaultConfig: Config = {
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectPath: "/auth/oauth/google/callback",
  scope:
    "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
  authorizationParams: {},
};

/** An OAuth error code as Google sends it, or `fallback` for anything else. */
function errorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

export class GoogleOAuthProvider extends OAuthProvider {
  config: Config;
  constructor(config: Partial<Config> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
  }

  /** `HOST_NAME` + `redirectPath`, the same for the authorization and the exchange. */
  redirectUri() {
    return `${process.env.HOST_NAME ?? ""}${this.config.redirectPath}`;
  }

  getRedirectUrl(_req?: HttpRequest, ctx?: OAuthAuthorizationContext) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    const params: Record<string, string> = {
      include_granted_scopes: "true",
      ...this.config.authorizationParams,
      scope: this.config.scope,
      response_type: "code",
      redirect_uri: this.redirectUri(),
      client_id: this.config.clientId,
    };
    if (ctx) {
      params.state = ctx.state;
      params.code_challenge = ctx.codeChallenge;
      params.code_challenge_method = ctx.codeChallengeMethod;
    }

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  async onCallback(req: HttpRequest, ctx?: OAuthCallbackContext): Promise<OAuthProfile> {
    const code = req.search.get("code");
    if (!code) throw new OAuthCallbackError("missing_code");

    // In the body, not the query string: a URL carrying the client secret ends
    // up in proxy and server logs.
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri(),
    });
    if (ctx?.codeVerifier) body.set("code_verifier", ctx.codeVerifier);

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const token = await res.json().catch(() => ({}));
    if (!res.ok || typeof token?.access_token !== "string" || token.access_token === "") {
      console.error("Google OAuth error: token exchange failed", token?.error ?? res.status);
      throw new OAuthCallbackError(errorCode(token?.error, "exchange_failed"));
    }

    const userresponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const user = await userresponse.json().catch(() => ({}));

    // `sub` is the account's identity — Google documents it as stable across
    // email changes and never reused. `name` is display data and `email` can
    // change hands, so neither is returned as `providerId`. Without a `sub` the
    // response is not a user (an error body, a revoked token): return nothing,
    // which the callback refuses, rather than an email with no identity behind it.
    if (typeof user.sub !== "string" || user.sub === "") {
      console.error("Google OAuth error: sub not found in user info response", user);
      return {};
    }

    if (!user.email) {
      console.error("Google OAuth error: email not found in user info response", user);
    }

    return {
      providerId: user.sub,
      name: user.name,
      email: user.email,
      // Google's guidance: match accounts by email only when this is true.
      // Absent is not true.
      emailVerified: user.email_verified === true || user.email_verified === "true",
    };
  }
}
