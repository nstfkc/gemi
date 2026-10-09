import { randomBytes } from "node:crypto";
import type { HttpRequest } from "../http/HttpRequest";
import type { SessionWithUser, User } from "./types";
import type { OAuthProvider } from "./oauth/OAuthProvider";
import type { ConnectionStore } from "./connections/ConnectionStore";
import type { ProviderConnection } from "./connections/ConnectionManager";
import type { OAuthConnectionProvider } from "./connections/OAuthConnectionProvider";
import { SignUpRequest } from "./requests";
import type { CodeRateLimits } from "./oneTimeCode";

/** What `emailCode.send` is handed. */
export interface EmailCodeSendArgs {
  /** Normalized: trimmed and lowercased. */
  email: string;
  /** The one-time code, as typed. Never stored like this. */
  code: string;
  /**
   * A one-time link token for the same row, for an email that offers a link
   * as well as a code (`/auth/sign-in/magic-link?email=&token=`).
   */
  token: string;
  /** No user has this address yet; verifying the code will create one. */
  isNewUser: boolean;
  req: HttpRequest<any, any>;
}

/**
 * One-time email codes (#708). The security settings here (`expiresInMinutes`,
 * `maxAttempts`, `requestLimit`, `verifyLimit`, `linkExpiresInMinutes`) apply
 * to the older `/auth/magic-link` + `/auth/sign-in-with-pin(-v2)` pair too,
 * whether or not `enabled` is on. `enabled`, `createUser`, `length` and `send`
 * are for `POST /auth/email-code` and `/auth/email-code/verify` only.
 */
export interface EmailCodeConfig {
  /** Serves `/auth/email-code` and `/auth/email-code/verify`. Default `false`: both answer 404. */
  enabled?: boolean;
  /**
   * Sign-up-or-sign-in: an address with no user gets a code too, and verifying
   * it creates the user (verified, inside the same transaction as
   * `onUserCreated`). Default `false`: an unknown address is sent nothing, and
   * the request answers exactly as it would for a known one.
   */
  createUser?: boolean;
  /** Digits in a code from `/auth/email-code`. Default 6. `/auth/magic-link` PINs stay 6. */
  length?: number;
  /** How long a code (PIN) can be used. Default 10. */
  expiresInMinutes?: number;
  /**
   * How long the link token issued with the code can be used, on
   * `/auth/sign-in/magic-link`. Default 7 days. A link carries 256 random
   * bits, so it is not guessable the way a code is; this bounds how long an
   * old email stays a key.
   */
  linkExpiresInMinutes?: number;
  /** Wrong guesses one code survives; the next one burns it. Default 5. */
  maxAttempts?: number;
  /**
   * Requests for a code (`/auth/email-code` and `/auth/magic-link`).
   * Default `{ perEmail: [5, 900], perIp: [20, 900] }`. Over it: 429
   * `{ error: { kind: "rate_limit" } }`.
   */
  requestLimit?: CodeRateLimits;
  /**
   * Guesses (`/auth/email-code/verify` and `/auth/sign-in-with-pin(-v2)`).
   * Default `{ perEmail: [10, 900], perIp: [50, 900] }`. Its `perIp` also
   * limits `/auth/sign-in/magic-link`, on a counter of its own; the link spends
   * no per-address budget, since a 256-bit token is not guessed.
   */
  verifyLimit?: CodeRateLimits;
  /**
   * `/auth/magic-link` answers `{ email: null }` for an address with no user,
   * which tells anyone asking whether it has an account. Clients built against
   * that (they treat `null` as "no account") keep working while this is
   * `false`, the default. `true` answers `{ email }` for every address.
   * `/auth/email-code` never reveals it.
   */
  uniformMagicLinkResponse?: boolean;
  /**
   * Delivers a code from `/auth/email-code`. Awaited before the request
   * answers, so for an answer that takes the same time whether or not an
   * address gets a code, enqueue the mail here rather than sending it inline.
   * Unset, the code is logged outside production and dropped in it.
   */
  send?: (args: EmailCodeSendArgs) => Promise<void> | void;
}

/** What `onConnected` is handed. */
export interface ConnectedArgs {
  user: User;
  /** The key under `auth.connections`. */
  provider: string;
  connection: ProviderConnection;
  /**
   * What the provider said about the account while connecting, when its
   * connection provider reports it (`InstagramConnectionProvider`: `id`,
   * `user_id`, `username`, `name`, `account_type`, `profile_picture_url`).
   * Not stored by gemi: keep what you need. `null` otherwise.
   */
  profile: Record<string, unknown> | null;
  req: HttpRequest<any, any>;
}

/** What `onAuthenticated` is handed. */
export interface AuthenticatedArgs {
  user: User;
  session: any;
  /** The user was created by this sign-in (email code, or a first OAuth sign-in). */
  isNewUser: boolean;
  method: "password" | "email-code" | "magic-link" | "oauth";
  req: HttpRequest<any, any>;
}

/**
 * Decides whether a pre-0.64 session is converted to a `v2.` one. See
 * `AuthConfig.migrateLegacySession`.
 */
export type LegacySessionMigrator = (
  session: SessionWithUser,
  ctx: {
    /** The old token, as the request carried it. */
    token: string;
    req: HttpRequest<any, any>;
    userAgent: string;
  },
) => boolean | Promise<boolean>;

// Config key: `auth`.
export interface AuthConfig {
  basePath?: string;
  verifyEmail?: boolean;
  /**
   * Where a signed-in user goes when there is no intended URL to return to —
   * the fallback of `Auth.intendedUrl()` and of the OAuth callback's
   * `redirectTo`.
   */
  redirectPath?: string;
  /**
   * The sign-in page `AuthenticationMiddleware` (and `Auth.user()`) sends a
   * signed-out view request to. The page that was asked for rides along as
   * `?redirect=`, for `useIntendedUrl()` / `Auth.intendedUrl()` to return to.
   * A path, or an absolute URL for sign-in hosted elsewhere. One route can
   * override it with `"auth:/other/sign-in"`.
   */
  signInPath?: string;

  sessionExpiresInHours?: number;
  sessionAbsoluteExpiresInHours?: number;

  /**
   * Shares the session cookie across subdomains. `"root"` is
   * `route.domains.root`; a hostname names the domain outright. Applied only
   * to a request whose host is that domain or one of its subdomains — on a
   * custom domain the browser would refuse it, so a custom domain keeps its
   * own session and its users sign in there. `null`, the default, scopes the
   * cookie to the host that set it.
   */
  cookieDomain?: "root" | (string & {}) | null;

  /**
   * Converts a session token from before 0.64 instead of refusing it, so an
   * upgrade need not sign everybody out. `null`, the default, refuses such a
   * token without looking it up, as `getSession` always has.
   *
   * When set, a token without the `v2.` prefix is looked up with
   * `findSession`; a row that has a user is handed to this function, and
   * `true` converts it. The conversion is gemi's, not the function's: the
   * session is written again under a minted `v2.` token with a fresh lifetime,
   * the old row is deleted, and the new token goes out as the `access_token`
   * cookie on this response — whether the old one arrived as the cookie or as
   * the header. The old token keeps resolving to the new session for 10 to 20
   * minutes, for requests already in flight with it, and then grants nothing.
   * Signing out with the old token in that time ends the converted session
   * too, and a sign-out and a conversion of one token never interleave.
   *
   * The row's expiry is not checked for you. Before 0.64 nothing enforced or
   * extended `expiresAt`, so a row in daily use can carry one long past; decide
   * here what is too old, from `session.absoluteExpiresAt` or your own columns.
   * This is also where a sunset belongs — answer `false` after it — and once
   * it has passed, remove the option.
   *
   * Only a request is converted: outside one there is no response to carry
   * the new cookie, and the token is refused until the client's next request
   * converts it.
   */
  migrateLegacySession?: LegacySessionMigrator | null;

  signUpRequest?: new () => HttpRequest<any, any>;
  oauthProviders?: Record<string, OAuthProvider>;
  /**
   * Where a failed OAuth callback sends the browser, with the reason as
   * `?error=` (`access_denied`, `invalid_state`, `email_not_verified`, …) and
   * the page the sign-in was meant to return to as `?redirect=`, when there was
   * one. A same-origin path, typically the sign-in page. `null`, the default,
   * renders the callback view with `{ session: null, error, redirectTo }`
   * instead.
   */
  oauthFailurePath?: string | null;
  /**
   * Where a successful OAuth sign-in sends a user who has **no email** (one
   * created through a provider with `createUsersWithoutEmail`, such as
   * Instagram), instead of the intended page, which rides along as
   * `?redirect=`. A same-origin path: a page that asks for an email and
   * saves it (verify it before trusting it). `null`, the default, sends them
   * on like everyone else.
   */
  oauthCompleteProfilePath?: string | null;

  /**
   * Providers a user can connect their account to, to call the provider's API
   * on their behalf (as opposed to `oauthProviders`, which sign in). The key
   * is the provider's name in `/auth/connections/<name>` and in
   * `Connections.for(user, name)`. See "OAuth connections" in
   * docs/authentication.md.
   */
  connections?: Record<string, OAuthConnectionProvider>;
  /**
   * Where connections are kept. Default: the `gemi_oauth_connections` table on
   * the default database connection, tokens encrypted with the app's
   * encryption keys.
   */
  connectionStore?: ConnectionStore | (() => ConnectionStore) | null;
  /** After a connection is stored by the connect callback. */
  onConnected?: (args: ConnectedArgs) => Promise<void> | void;

  verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  hashPassword?: (password: string) => Promise<string>;
  generateForgotPasswordToken?: (user: User) => Promise<string>;
  generateEmailVerificationToken?: (
    email: string,
  ) => Promise<string> | string;
  generateMagicLinkToken?: (email: string) => Promise<string> | string;

  // Extra claims merged into the session payload.
  extendSession?: <T extends User>(user: T) => Promise<any> | any;

  /**
   * **This one is not a notification, whatever the name suggests.** It runs
   * *inside* the transaction that creates the user, after the row is written
   * and before it commits, and a throw rolls the user back. Every other `onXxx`
   * here fires after its work is committed and can only report; this one
   * participates in the write.
   *
   * The past tense is worth distrusting, then, and it is deliberate that this
   * paragraph comes first: an application that mistakes this for `onSignUp`
   * with better timing, and swallows its own errors inside it, gets exactly the
   * orphaned user the hook exists to prevent.
   *
   * That is what it is for: an application that must create rows *alongside*
   * every user — an organization, a workspace, a default settings row — has
   * nowhere else to do it atomically. `onSignUp` fires after the commit on both
   * paths, so provisioning there leaves an orphaned user when the second insert
   * fails, which is a failure that only turns up in production.
   *
   * Fires on all three creation paths — email/password sign-up, invited
   * sign-up, and first OAuth sign-in — and receives the same password-stripped
   * user the endpoint returns, so a hook that logs its argument does not log a
   * credential hash.
   *
   * On the invited path the inviting organization's `Account` row is already
   * written when this runs, so a hook provisioning an own workspace should
   * check before adding a second one.
   *
   * Four constraints come from where this runs:
   *
   * - **Writes to a policied model need `Model.asSystem`.** This runs with no
   *   user in scope — a sign-up has not authenticated anybody yet — so a policy
   *   whose `scope` or `onCreate` reads `ctx.user` raises `PolicyDeniedError`
   *   under deny-by-default, and the rollback takes the user with it. That is
   *   the correct behaviour and the reason this hook is *not* wrapped in
   *   `UserProvider.run`: suspending policies for application code is a
   *   sentence somebody types, never something a framework does quietly. Say it
   *   at the call site:
   *
   *       await Model.asSystem(() => Organization.create({ data }))
   *
   * - **Errors thrown here reach the client as-is.** A `ValidationError` is a
   *   400 on `POST /sign-up`; anything else is a 500. On the OAuth path there
   *   is no form to fail — a throw is a 500 page mid-redirect. Either way no
   *   user is created.
   * - **Raw queries do not join the transaction.** ORM calls at any depth do,
   *   automatically; a hand-written Prisma or `DB` statement runs outside and
   *   survives the rollback.
   * - **`Promise.all` over ORM calls is not safe here.** The transaction holds
   *   one reserved connection, so await them in sequence. Keep network and
   *   filesystem I/O out entirely — the connection is held for as long as this
   *   runs.
   */
  onUserCreated?: (user: User) => Promise<void>;

  onSignUp?: (
    user: User,
    verificationToken: string,
    search: Record<string, string>,
  ) => Promise<void> | void;
  onSignIn?: (
    session: any,
    search: Record<string, string>,
  ) => Promise<void> | void;
  onSignOut?: (session: any) => Promise<void> | void;
  onForgotPassword?: (
    user: any,
    verificationToken: string,
  ) => Promise<void> | void;
  onResetPassword?: (session: any) => Promise<void> | void;
  onMagicLinkCreated?: (
    session: any,
    args: { email: string; token: string; pin: string },
  ) => Promise<void> | void;

  /** One-time email codes, and the limits on the magic-link PIN routes. See `EmailCodeConfig`. */
  emailCode?: EmailCodeConfig;

  /**
   * The code to issue for `email`, on `/auth/magic-link`, `Auth.createMagicLink`
   * and `/auth/email-code`. Return nothing for the default, random digits.
   *
   * For fixed test accounts, instead of rewriting the stored `pin` after the
   * fact (the column holds a hash now, so such a rewrite no longer matches):
   *
   *     generateCode: (email) =>
   *       process.env.APP_ENV !== "production" && email.endsWith("+e2e@example.com")
   *         ? "000000"
   *         : undefined,
   */
  generateCode?: (
    email: string,
  ) => string | null | undefined | Promise<string | null | undefined>;

  /**
   * Fires after every sign-in that sets a session: password, PIN or link,
   * email code, OAuth. Unlike `onSignIn` it has the request, so it can read a
   * cookie or header the app set before sign-in (an anonymous owner id, say)
   * and claim that work for `user`, and it says whether the user is new.
   * Fires after the session is committed; a throw fails the response but not
   * the sign-in.
   */
  onAuthenticated?: (args: AuthenticatedArgs) => Promise<void> | void;
}

/**
 * Throws at boot on a setting that would otherwise surface as a 500 on every
 * sign-in (a `maxAttempts` of 0 reaches the rate limiter as a zero limit) or
 * quietly weaken the codes (a 2-digit code).
 */
function checkEmailCodeNumber(name: string, value: number, min: number, max = Infinity) {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `an integer of at least ${min}` : `an integer from ${min} to ${max}`;
    throw new Error(`auth.emailCode.${name} must be ${range}, got ${value}`);
  }
}

export function emailCodeDefaults(config: EmailCodeConfig = {}): Required<EmailCodeConfig> {
  const length = config.length ?? 6;
  const expiresInMinutes = config.expiresInMinutes ?? 10;
  const linkExpiresInMinutes = config.linkExpiresInMinutes ?? 7 * 24 * 60;
  const maxAttempts = config.maxAttempts ?? 5;
  checkEmailCodeNumber("length", length, 4, 12);
  checkEmailCodeNumber("expiresInMinutes", expiresInMinutes, 1);
  checkEmailCodeNumber("linkExpiresInMinutes", linkExpiresInMinutes, 1);
  checkEmailCodeNumber("maxAttempts", maxAttempts, 1);
  return {
    enabled: config.enabled ?? false,
    createUser: config.createUser ?? false,
    length,
    expiresInMinutes,
    linkExpiresInMinutes,
    maxAttempts,
    requestLimit: {
      perEmail: config.requestLimit?.perEmail ?? [5, 900],
      perIp: config.requestLimit?.perIp ?? [20, 900],
    },
    verifyLimit: {
      perEmail: config.verifyLimit?.perEmail ?? [10, 900],
      perIp: config.verifyLimit?.perIp ?? [50, 900],
    },
    uniformMagicLinkResponse: config.uniformMagicLinkResponse ?? false,
    send:
      config.send ??
      (({ email, code }) => {
        if (process.env.NODE_ENV !== "production") {
          console.info(`[gemi] email code for ${email}: ${code} (set auth.emailCode.send to deliver it)`);
        }
      }),
  };
}

/**
 * The default `verifyPassword`: `false` for anything that is not a hash it can
 * check, rather than an exception.
 *
 * `password` is nullable — a user created through OAuth has none — and
 * `Bun.password.verify` throws `UnsupportedAlgorithm` for `null` and for any
 * string it cannot read as a hash. Sign-in let that escape as a 500 where a
 * wrong password answers `invalid_credentials`, which also told anyone asking
 * that the address has an account (#276). A malformed hash is corrupt data
 * rather than a wrong password, but the answer to "does this password match"
 * is still no.
 */
export async function verifyPasswordHash(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (typeof hash !== "string" || hash === "") {
    return false;
  }
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function defineAuthConfig(config: AuthConfig): AuthConfig {
  return config;
}

// `generateEmailVerificationToken`'s default short-circuits on `verifyEmail`,
// so the already-merged config is threaded in to keep that behaviour intact.
export function authConfigDefaults(
  config: AuthConfig = {},
): Required<AuthConfig> {
  return {
    basePath: "/auth",
    verifyEmail: true,
    redirectPath: "/dashboard",
    signInPath: "/auth/sign-in",

    sessionExpiresInHours: 24,
    sessionAbsoluteExpiresInHours: 24 * 7 * 4,
    cookieDomain: null,
    migrateLegacySession: null,

    signUpRequest: SignUpRequest as any,
    oauthProviders: {},
    oauthFailurePath: null,
    oauthCompleteProfilePath: null,
    connections: {},
    connectionStore: null,
    onConnected: () => {},

    verifyPassword: verifyPasswordHash,
    hashPassword: async (password) => await Bun.password.hash(password),
    // Random, not derived. These used to be sha256(email + Date.now()), which
    // anyone who asked for a reset could recompute: the email is theirs to
    // choose and the millisecond is within a second of their own request.
    generateForgotPasswordToken: async () => randomBytes(32).toString("hex"),
    generateEmailVerificationToken: () => {
      if (!(config.verifyEmail ?? true)) {
        return "";
      }
      return randomBytes(32).toString("hex");
    },
    generateMagicLinkToken: () => randomBytes(32).toString("hex"),

    extendSession: () => ({}),

    // `async`, unlike its neighbours: the call site awaits it inside a
    // transaction, so it has to be a promise rather than sometimes one.
    onUserCreated: async () => {},
    onSignUp: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    onForgotPassword: () => {},
    onResetPassword: () => {},
    onMagicLinkCreated: () => {},
    emailCode: emailCodeDefaults(config.emailCode),
    generateCode: () => undefined,
    onAuthenticated: () => {},
  };
}
