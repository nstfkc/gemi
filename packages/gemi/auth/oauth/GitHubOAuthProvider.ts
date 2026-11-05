import type { HttpRequest } from "../../http/HttpRequest";
import { configuredAppOrigin } from "../../utils/appOrigin";
import { type OAuthClientResolver, type ResolvedOAuthClient, resolveOAuthClient } from "./client";
import {
  type OAuthAuthorizationContext,
  type OAuthCallbackContext,
  OAuthCallbackError,
  OAuthProvider,
  type OAuthProfile,
} from "./OAuthProvider";

export interface GitHubOAuthProviderConfig {
  /** The OAuth app's client id. Default `process.env.GITHUB_CLIENT_ID`. */
  clientId: string;
  /** The OAuth app's client secret. Default `process.env.GITHUB_CLIENT_SECRET`. */
  clientSecret: string;
  /**
   * The callback path, on `HOST_NAME` (or the origin `resolve` answers): the
   * `redirect_uri` of both the authorization URL and the code exchange.
   * Default `/auth/oauth/github/callback`.
   */
  redirectPath: string;
  /** Default `read:user user:email`: the profile, and the addresses to find the verified primary one. */
  scope: string;
  /**
   * Extra parameters for GitHub's authorization URL, such as
   * `{ allow_signup: "false" }` or `{ prompt: "select_account" }`. They cannot
   * replace `state`, the PKCE challenge, `redirect_uri` or `client_id`.
   */
  authorizationParams: Record<string, string>;
  /**
   * The client and callback origin per request (#1140):
   * `({ req, origin }) => ({ clientId, clientSecret, origin })`. What it
   * leaves out comes from the options above; `null` turns the provider off
   * for the request.
   */
  resolve?: OAuthClientResolver;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";

/** An OAuth error code as GitHub sends it, or `fallback` for anything else. */
function errorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

interface GitHubEmail {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

/**
 * "Sign in with GitHub", through a GitHub OAuth app.
 *
 * ```ts
 * oauthProviders: { github: new GitHubOAuthProvider() }
 * ```
 *
 * The account's identity (`providerId`) is its numeric GitHub user id, as a
 * string, never the login, which its owner can change and someone else can
 * then take. The email is the account's **primary, verified** address from
 * `GET /user/emails` (the `user:email` scope), reported with
 * `emailVerified: true`. Without one (no verified primary address, or the
 * scope was not granted) the profile's public email is returned, if any, as
 * unverified, which the callback does not sign into an existing user by.
 */
export class GitHubOAuthProvider extends OAuthProvider {
  config: GitHubOAuthProviderConfig;

  constructor(config: Partial<GitHubOAuthProviderConfig> = {}) {
    super();
    this.config = {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      redirectPath: "/auth/oauth/github/callback",
      scope: "read:user user:email",
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
      name: "GitHubOAuthProvider",
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

  /** Synchronous without `resolve`. */
  getRedirectUrl(req?: HttpRequest, ctx?: OAuthAuthorizationContext): string | Promise<string> {
    if (!this.config.resolve) return this.authorizationUrl(this.staticClient(), ctx);
    return this.clientFor(req ?? null).then((client) => {
      if (!client) throw new Error("GitHubOAuthProvider is not offered on this request.");
      return this.authorizationUrl(client, ctx);
    });
  }

  private authorizationUrl(client: ResolvedOAuthClient, ctx?: OAuthAuthorizationContext) {
    const url = new URL(AUTHORIZE_URL);
    const params: Record<string, string> = {
      ...this.config.authorizationParams,
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      scope: this.config.scope,
      response_type: "code",
    };
    if (ctx) {
      params.state = ctx.state;
      params.code_challenge = ctx.codeChallenge;
      params.code_challenge_method = ctx.codeChallengeMethod;
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async onCallback(req: HttpRequest, ctx?: OAuthCallbackContext): Promise<OAuthProfile> {
    const code = req.search.get("code");
    if (!code) throw new OAuthCallbackError("missing_code");
    const client = this.config.resolve ? await this.clientFor(req) : this.staticClient();
    if (!client) throw new OAuthCallbackError("unknown_provider");

    // The secret in the body, not the URL, which ends up in logs. Without
    // `Accept: application/json` GitHub answers form-encoded.
    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: client.redirectUri,
    });
    if (ctx?.codeVerifier) body.set("code_verifier", ctx.codeVerifier);

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const token = await res.json().catch(() => ({}));
    // GitHub reports a bad code with a 200 and an `error` field.
    if (!res.ok || typeof token?.access_token !== "string" || token.access_token === "") {
      console.error("GitHub OAuth error: token exchange failed", token?.error ?? res.status);
      throw new OAuthCallbackError(errorCode(token?.error, "exchange_failed"));
    }

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.access_token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub's API refuses a request without one.
      "User-Agent": "gemi",
    };

    const userResponse = await fetch(`${API_URL}/user`, { headers });
    const user = await userResponse.json().catch(() => ({}));
    // The numeric id is the account; the login can be renamed and reused.
    // Without one the response is not a user (an error body, a revoked
    // token): return nothing, which the callback refuses.
    if (!userResponse.ok || typeof user?.id !== "number" || !Number.isSafeInteger(user.id)) {
      console.error("GitHub OAuth error: no user id in the /user response", userResponse.status);
      return {};
    }

    const login = typeof user.login === "string" && user.login !== "" ? user.login : undefined;
    const name = typeof user.name === "string" && user.name !== "" ? user.name : login;
    const primary = await this.primaryVerifiedEmail(headers);
    const profileEmail =
      typeof user.email === "string" && user.email !== "" ? user.email : undefined;

    return {
      providerId: String(user.id),
      username: login,
      name,
      // Verified only when GitHub says so for the primary address. The
      // profile's public email is a fallback reported as unverified.
      ...(primary
        ? { email: primary, emailVerified: true }
        : profileEmail
          ? { email: profileEmail, emailVerified: false }
          : {}),
    };
  }

  /** The primary address from `GET /user/emails` when it is verified, else `undefined`. */
  private async primaryVerifiedEmail(headers: Record<string, string>): Promise<string | undefined> {
    const res = await fetch(`${API_URL}/user/emails`, { headers }).catch(() => null);
    if (!res?.ok) {
      console.error("GitHub OAuth error: could not read /user/emails", res?.status);
      return undefined;
    }
    const emails: unknown = await res.json().catch(() => null);
    if (!Array.isArray(emails)) return undefined;
    const primary = (emails as GitHubEmail[]).find(
      (entry) => entry?.primary === true && entry.verified === true,
    );
    return typeof primary?.email === "string" && primary.email !== "" ? primary.email : undefined;
  }
}
