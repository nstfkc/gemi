import { randomBytes } from "node:crypto";
import type { HttpRequest } from "../http/HttpRequest";
import type { User } from "./types";
import type { OAuthProvider } from "./oauth/OAuthProvider";
import { SignUpRequest } from "./requests";

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

  signUpRequest?: new () => HttpRequest<any, any>;
  oauthProviders?: Record<string, OAuthProvider>;

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

    signUpRequest: SignUpRequest as any,
    oauthProviders: {},

    verifyPassword: async (password, hash) =>
      await Bun.password.verify(password, hash),
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
  };
}
