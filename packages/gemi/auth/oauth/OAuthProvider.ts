import { HttpRequest } from "../../http/HttpRequest";
import type { ResolvedOAuthClient } from "./client";

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
   * Whether a first sign-in through this provider may sign into an existing
   * user who has the same email. `true` (the default) links the provider
   * identity to that user, which is right when the provider has verified the
   * address (`emailVerified: true`, Google's `email_verified`).
   *
   * Set it to `false` for a provider that does not promise the email it
   * returns is verified: an address anyone can type into their profile there
   * must not sign into the account of whoever owns it here. The callback then
   * refuses with `account_exists`, the user signs in the way they did before
   * and links the provider from there. A new email still creates a user.
   */
  linkByEmail?: boolean = true;

  /**
   * Whether a sign-in through this provider may create a user. `true` (the
   * default) creates one for an identity that is not linked and whose email
   * no user has.
   *
   * Set it to `false` for a provider users may only sign in with once they
   * have linked it to an account they made another way: the callback then
   * refuses such an identity with `signup_disabled`, and only an identity
   * already linked (or, with `linkByEmail`, an existing user's verified email)
   * signs in.
   */
  createUsers?: boolean = true;

  /**
   * Whether a first sign-in may create a user **without an email**, for a
   * provider that never returns one (Instagram). `false` (the default)
   * refuses an unlinked identity without an email with `missing_email`.
   *
   * When `true`, such an identity (it must have a `providerId`) gets a new
   * user whose `email` is `null`, linked by a `SocialAccount` row: the account
   * is the provider identity, and it signs back in by it. The user model's
   * `email` has to be nullable (`String? @unique`, as in the templates). Point
   * `auth.oauthCompleteProfilePath` at a page that asks these users for an
   * email. `createUsers = false` still refuses them with `signup_disabled`.
   */
  createUsersWithoutEmail?: boolean = false;

  /**
   * The client this provider uses for `req`, for a provider whose client or
   * callback origin depends on the request (#1140). The built-in providers
   * answer from their `resolve` option, else their static config. `null`:
   * the provider is not offered on this request, so its routes answer 404 and
   * `Auth.oauthProviders()` leaves it out. `undefined` (the default): the
   * provider has no per-request client, and is always offered.
   *
   * `req` is `null` outside a request, where a per-request client cannot be
   * resolved.
   */
  protected clientFor(
    _req: HttpRequest<any, any> | null,
  ): Promise<ResolvedOAuthClient | null | undefined> {
    return Promise.resolve(undefined);
  }

  /** Whether this provider is offered on `req`: `clientFor` does not answer `null`. */
  async isAvailable(req: HttpRequest<any, any> | null): Promise<boolean> {
    return (await this.clientFor(req)) !== null;
  }

  /**
   * The `redirect_uri` this provider sends for `req`, when it has one to
   * report. `oauthRedirect` keeps it with the round trip's state, and
   * `oauthCallback` refuses a callback for which it answers otherwise
   * (`redirect_mismatch`): the code is then exchanged by the client, and with
   * the `redirect_uri`, that asked for it.
   */
  async redirectUriFor(req: HttpRequest<any, any>): Promise<string | undefined> {
    return (await this.clientFor(req))?.redirectUri;
  }

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
