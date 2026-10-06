import { HttpRequest } from "../../http/HttpRequest";

/**
 * What `oauthRedirect` hands `getRedirectUrl`: the round trip's `state` and
 * PKCE challenge, which gemi has already stored for the callback to check.
 *
 * A provider puts `state` on the authorization URL **as is** — the callback is
 * refused unless the provider echoes it back. `codeChallenge` goes on the URL
 * too (with `code_challenge_method=S256`) for a provider that supports PKCE.
 */
export interface OAuthAuthorizationContext {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/**
 * What `oauthCallback` hands `onCallback`, once the `state` has been checked:
 * the PKCE verifier to send with the token exchange.
 */
export interface OAuthCallbackContext {
  state: string;
  codeVerifier: string;
}

export interface OAuthProfile {
  email?: string;
  /**
   * Whether the provider says it has verified `email`. `false` refuses a
   * callback that would sign in or create a user by that email; a provider that
   * cannot tell leaves it undefined. Report it whenever the provider exposes it
   * (Google's `email_verified`).
   */
  emailVerified?: boolean;
  name?: string;
  username?: string;
  providerId?: string;
}

/**
 * A failed callback, carrying the reason code the app is given (`?error=` on
 * `auth.oauthFailurePath`, and `error` in the callback view's props). Throw it
 * from `onCallback` for a failure with a known reason — `invalid_grant` from a
 * token exchange, say. Any other error thrown there is reported as
 * `provider_error`.
 */
export class OAuthCallbackError extends Error {
  code: string;
  constructor(code: string, message = `OAuth callback failed: ${code}`) {
    super(message);
    this.name = "OAuthCallbackError";
    this.code = code;
  }
}

export abstract class OAuthProvider {
  /**
   * The provider's authorization URL. Put `ctx.state` on it unchanged — a
   * callback whose `state` does not match is refused — and `ctx.codeChallenge`
   * when the provider supports PKCE.
   */
  abstract getRedirectUrl(
    req: HttpRequest,
    ctx?: OAuthAuthorizationContext,
  ): string | Promise<string>;
  /**
   * `providerId` is the provider's stable account identifier (Google's `sub`,
   * X's user id) — the value the callback recognises a returning account by.
   * Return it whenever the provider has one. Never derive it from a name or an
   * email: those change, and a matching one is not the same account. A provider
   * that returns none falls back to matching by `email`, and no `SocialAccount`
   * is written for it.
   *
   * Called only once the round trip's `state` has been verified, and never for
   * a callback carrying `?error=`. Send `ctx.codeVerifier` with the token
   * exchange when the authorization URL carried a challenge.
   */
  abstract onCallback(req: HttpRequest, ctx?: OAuthCallbackContext): Promise<OAuthProfile>;
}
