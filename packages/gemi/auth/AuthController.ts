import { randomBytes } from "node:crypto";
import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { AuthorizationError } from "../http/errors";
import { RequestBreakerError } from "../http/Error";
import { enforceCodeRateLimits, foldEmail, normalizeEmail } from "./oneTimeCode";
import type { AuthConfig, AuthenticatedArgs } from "./config";
import { Auth } from "../facades";
import { app } from "../foundation/app";
import { Translator } from "../i18n/Translator";
import type { Invitation, User } from "./types";
import { AuthManager } from "./AuthManager";
import { readAccessToken } from "./accessToken";
import { INTENDED_URL_PARAM, isSecureRequest, safeRedirectPath } from "../utils/intendedUrl";
import { Redirect } from "../facades/Redirect";
import { OAuthCallbackError } from "./oauth/OAuthProvider";
import {
  OAUTH_STATE_TTL_SECONDS,
  createOAuthState,
  oauthStateCookieName,
  verifyOAuthState,
} from "./oauth/oauthState";

/**
 * A hash of a random password, for `passwordMatches` to verify against when
 * there is no stored hash. Made with the configured `hashPassword`, so it costs
 * what a real one does under whatever scheme the app uses, and once per
 * `hashPassword`.
 */
const decoyHashes = new WeakMap<object, Promise<string>>();

function decoyHash(hashPassword: (password: string) => Promise<string>) {
  let hash = decoyHashes.get(hashPassword);
  if (!hash) {
    hash = hashPassword(randomBytes(32).toString("hex"));
    decoyHashes.set(hashPassword, hash);
    // A failure is not cached: the next attempt tries again.
    hash.catch(() => decoyHashes.delete(hashPassword));
  }
  return hash;
}

/**
 * Whether `password` matches the stored hash — `false` when there is none.
 *
 * A user created through OAuth has no password, and an unknown address has no
 * user. Both answer the same as a wrong password, and take as long: a hash is
 * verified either way, against a decoy when there is nothing stored, so
 * neither the response nor its timing says which of the three it was (#276).
 * `verifyPassword` is never handed a missing hash, so a custom one typed
 * `(password, hash: string)` needs no guard of its own.
 */
async function passwordMatches(
  config: {
    verifyPassword: (password: string, hash: string) => Promise<boolean>;
    hashPassword: (password: string) => Promise<string>;
  },
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (typeof hash === "string" && hash !== "") {
    return await config.verifyPassword(password, hash);
  }
  // Only the time is wanted, so a failure here is no reason to fail the
  // request: the answer is `false` whatever the decoy check does.
  try {
    await config.verifyPassword(password, await decoyHash(config.hashPassword));
  } catch {}
  return false;
}

/**
 * `onAuthenticated`, with `user` taken off the session when not given and its
 * password hash left out.
 */
async function notifyAuthenticated(
  config: { onAuthenticated?: AuthConfig["onAuthenticated"] },
  args: Omit<AuthenticatedArgs, "user"> & { user?: User },
) {
  const user = args.user ?? args.session?.user;
  if (!user || !config.onAuthenticated) return;
  const { password: _, ...safe } = user as User;
  await config.onAuthenticated({ ...args, user: safe as User });
}

/** Thrown inside the sign-up transaction to roll it back when the code was taken. */
class CodeAlreadyClaimed extends Error {}

/**
 * Request input is checked for its runtime type before it reaches a query.
 *
 * A JSON body can carry an object or an array wherever a string was expected,
 * and the type parameter on `HttpRequest` checks nothing at runtime. Handed to
 * the ORM, such a value is not a value to match but a filter, so every auth
 * route takes its identifiers through these and answers anything that is not a
 * string exactly as it answers a wrong one.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function emailInput(value: unknown): string | null {
  return foldEmail(value);
}

/**
 * The longest code the PIN routes accept. A code is six digits by default,
 * `emailCode.length` digits on `/auth/email-code`, or whatever non-empty
 * string `generateCode` returns, so the format is not checked here; the code
 * is compared as a keyed hash, never handed to a query.
 */
export const MAX_PIN_LENGTH = 256;

/** A typed PIN, or `null` for what is not a non-empty string within `MAX_PIN_LENGTH`. */
export function pinValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_PIN_LENGTH
    ? value
    : null;
}

/** Holds a `?redirect=` across the OAuth provider round trip. */
const INTENDED_URL_COOKIE = "intended_url";

function clearIntendedUrlCookie(req: HttpRequest<any, any>) {
  if (req.cookies.get(INTENDED_URL_COOKIE)) {
    req.ctx().setCookie(INTENDED_URL_COOKIE, "", { maxAge: -1 });
  }
}

/**
 * The page `oauthRedirect` was asked to return to, if any, and the cookie that
 * held it cleared. Checked again on the way out: a cookie is client-writable
 * too.
 */
function takeIntendedUrl(req: HttpRequest<any, any>): string | null {
  const stashed = req.cookies.get(INTENDED_URL_COOKIE);
  if (!stashed) return null;
  clearIntendedUrlCookie(req);
  try {
    return safeRedirectPath(decodeURIComponent(stashed), "") || null;
  } catch {
    return null;
  }
}

class SignInRequest extends HttpRequest<
  {
    email: string;
    password: string;
  },
  Record<string, string>
> {
  schema = {
    email: {
      required: "Email is required",
      string: "Invalid email",
      email: "Invalid email",
    },
    password: {
      required: "Password is required",
    },
  };
}

class ForgotPasswordRequest extends HttpRequest<
  {
    email: string;
  },
  Record<string, string>
> {
  schema = {
    email: {
      required: "Email is required",
      email: "Invalid email",
    },
  };
}

class ResetPasswordRequest extends HttpRequest<
  {
    password: string;
    token: string;
  },
  Record<string, string>
> {
  schema = {
    password: {
      required: "Password is required",
      password: "Invalid password",
    },
  };
}

export class AuthController extends Controller {
  async me() {
    const user = await Auth.user();

    if (!user) {
      throw new AuthorizationError();
    }

    return user;
  }

  async verifyEmail(req = new HttpRequest<{ token: string }>()) {
    const input = await req.input();
    const { userProvider } = app(AuthManager);

    const token = nonEmptyString(input.get("token"));
    if (!token) {
      return { email: null };
    }

    const user = await userProvider.findUserByVerificationToken(token);

    if (!user) {
      return { email: null };
    }

    await userProvider.verifyUser(user.email);

    return {
      email: user.email,
    };
  }

  async signInWithMagicLink(req = new HttpRequest()) {
    const auth = app(AuthManager);
    const { userProvider } = auth;
    const token = nonEmptyString(req.search.get("token"));
    let email: string | null = null;
    try {
      email = foldEmail(decodeURIComponent(req.search.get("email") ?? ""));
    } catch {}

    // Per IP only. A 256-bit token is not guessed, so the link spends no
    // per-address budget: a user locked out of PINs by somebody else's
    // guesses can still sign in with the link from the same email (#708).
    await enforceCodeRateLimits("link", null, req, {
      perIp: auth.config.emailCode.verifyLimit.perIp,
    });

    // The row's hash is compared in constant time, its age checked against
    // `emailCode.linkExpiresInMinutes`, and it is deleted by whichever request
    // claims it first (#708).
    if (!email || !token || !(await auth.verifyMagicLinkToken(email, token))) {
      return { error: "Invalid token" };
    }

    await userProvider.verifyUser(email);
    const session = await auth.createOrUpdateSession({ email });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(session, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, isNewUser: false, method: "magic-link", req });

    return { session };
  }

  /**
   * The checks both PIN routes share: the verify rate limits, then the code.
   * Every refusal is the `ValidationError` on `pin` these routes have always
   * answered a wrong PIN with, so a client built before #708 shows it where it
   * showed "Invalid pin"; a rate limit is the middleware's 429.
   */
  private async verifyPinRequest(req: HttpRequest<{ email: string; pin: string }>) {
    const auth = app(AuthManager);
    const input = await req.input();
    const { email: rawEmail, pin: rawPin } = input.toJSON();
    const email = foldEmail(rawEmail);
    const pin = pinValue(rawPin);

    await enforceCodeRateLimits("verify", email, req, auth.config.emailCode.verifyLimit);

    // A PIN that is not a string never reaches the lookup or spends an attempt.
    if (!email || !pin) {
      throw new ValidationError({ pin: ["Invalid pin"] });
    }

    const result = await auth.verifyOneTimeCode(email, pin);
    if (result.status === "too_many_attempts") {
      throw new ValidationError({ pin: ["Too many attempts"] });
    }
    if (result.status !== "ok") {
      throw new ValidationError({ pin: ["Invalid pin"] });
    }

    await auth.userProvider.verifyUser(email);
    return email;
  }

  async signInWithPinV2(
    req = new HttpRequest<{ email: string; pin: string }>(),
  ) {
    const auth = app(AuthManager);
    const email = await this.verifyPinRequest(req);

    const session = await auth.createOrUpdateSessionV2({ email });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(session, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, isNewUser: false, method: "magic-link", req });

    return session;
  }

  async signInWithPin(req = new HttpRequest<{ email: string; pin: string }>()) {
    const auth = app(AuthManager);
    const email = await this.verifyPinRequest(req);

    const session = await auth.createOrUpdateSession({ email });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(session, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, isNewUser: false, method: "magic-link", req });

    return { session };
  }

  async signInV2(req = new SignInRequest()) {
    const input = await req.input();
    const { email: _email, password } = input.toJSON();
    const email = _email.toLowerCase().trim();

    const auth = app(AuthManager);

    const user = await auth.userProvider.findUserByEmailAddress(
      email,
      auth.config.verifyEmail,
    );

    // An unknown address is checked too, against a decoy, so it answers like a
    // wrong password in time as well as in body.
    // `SignInRequest` checks the email is a string; the password only that it
    // is present. Anything else is a wrong password.
    const isPasswordValid =
      typeof password === "string" &&
      (await passwordMatches(auth.config, password, user?.password));

    if (!user || !isPasswordValid) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const session = await auth.createOrUpdateSessionV2({
      email: user.email,
      id: user.id,
    });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(user, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, user, isNewUser: false, method: "password", req });

    const { password: _, ...rest } = user;

    return rest;
  }

  async signIn(req = new SignInRequest()) {
    const input = await req.input();
    const { email: _email, password } = input.toJSON();
    const email = _email.toLowerCase().trim();

    const auth = app(AuthManager);

    const user = await auth.userProvider.findUserByEmailAddress(
      email,
      auth.config.verifyEmail,
    );

    // An unknown address is checked too, against a decoy, so it answers like a
    // wrong password in time as well as in body.
    // `SignInRequest` checks the email is a string; the password only that it
    // is present. Anything else is a wrong password.
    const isPasswordValid =
      typeof password === "string" &&
      (await passwordMatches(auth.config, password, user?.password));

    if (!user || !isPasswordValid) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const session = await auth.createOrUpdateSession({
      email: user.email,
      id: user.id,
    });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(user, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, user, isNewUser: false, method: "password", req });

    const { password: _, ...rest } = user;

    return rest;
  }

  async signUp() {
    const auth = app(AuthManager);
    const { userProvider, config } = auth;
    const req = new config.signUpRequest();
    const input = await req.input();
    const {
      email: _email,
      password,
      name,
      invitationId,
    } = input.toJSON() as Record<string, any>;

    // `signUpRequest` is the application's to replace, so the types the
    // queries below depend on are checked here as well as by its schema.
    const email = emailInput(_email);
    if (!email) {
      throw new ValidationError({ email: ["Invalid email"] });
    }
    if (password != null && typeof password !== "string") {
      throw new ValidationError({ password: ["Invalid password"] });
    }
    if (invitationId != null && typeof invitationId !== "string") {
      throw new ValidationError({ invitationId: ["Invalid invitation"] });
    }

    const user = await userProvider.findUserByEmailAddress(email, false);

    if (user) {
      throw new ValidationError({
        email: ["Email address already exists"],
      });
    }

    const hashedPassword = await config.hashPassword(password);

    const locale = app(Translator).detectLocale(req);

    let invitation: Invitation;
    if (invitationId) {
      invitation = await userProvider.findInvitation(invitationId, email);
    }

    let newUser: User;
    // `""` rather than left undefined, because only the `else` branch below
    // assigns it. An invited sign-up sets `emailVerifiedAt` and never writes a
    // token, so there is nothing to verify — the same reason `oauthCallback`
    // passes `""` — and `onSignUp` is typed `verificationToken: string`. Left
    // undeclared, the invited path handed the hook `undefined` against that
    // signature.
    let verificationToken = "";

    // Both branches write the user and everything that has to exist alongside
    // it in one transaction, `config.onUserCreated` last. A throw from the hook
    // takes the user with it, which is the whole point of the hook: an app
    // provisioning an organization in `onSignUp` — which fires after the commit
    // — gets a user with no organization when that insert fails.
    if (invitation) {
      newUser = await userProvider.transaction(async () => {
        // Consuming the invitation belongs in here too. Deleted before the
        // transaction, a rollback would leave the invite burned and no user to
        // show for it, so the invitee could not retry.
        await userProvider.deleteInvitationById(invitationId);

        const user = await userProvider.createUser({
          email,
          name,
          password: hashedPassword,
          emailVerifiedAt: new Date(),
          locale,
        });
        await userProvider.createAccount({
          organizationId: invitation.organizationId,
          userId: user.id,
          organizationRole: invitation.role,
        });

        await config.onUserCreated(user);

        return user;
      });
    } else {
      // Outside the transaction: it is a hash, not a query, and the
      // transaction holds a connection for as long as it is open.
      verificationToken = await config.generateEmailVerificationToken(email);

      newUser = await userProvider.transaction(async () => {
        const user = await userProvider.createUser({
          email,
          name,
          password: hashedPassword,
          verificationToken,
          locale,
        });

        await config.onUserCreated(user);

        return user;
      });
    }

    await config.onSignUp(newUser, verificationToken, req.search.toJSON());

    return newUser;
  }

  async signOut(req = new HttpRequest()) {
    // Both transports, through the reader `auth` and `Auth.user()` use: a
    // browser's cookie, or the `access_token` header a native client sends.
    // Reading the cookie alone revoked nothing for a header client (#586).
    const token = readAccessToken(req);

    const auth = app(AuthManager);
    const { config } = auth;

    // Looked up, rather than resolved through `Auth.user()`, which goes
    // through `getSession`: that slides a session past half its window and
    // writes the cookie again — a second `Set-Cookie` for `access_token`
    // racing the one below that clears it, since a request's cookies are a
    // set of serialized strings, not a map.
    // `revokeSession` also ends the session a pre-0.64 token was converted to.
    const session = await auth.revokeSession(token, req.headers.get("User-Agent"));

    req
      .ctx()
      .setCookie(
        "access_token",
        "",
        app(AuthManager).accessTokenCookieOptions(req, new Date(0)),
      );
    // A cookie set before `cookieDomain` was turned on is scoped to the host
    // alone, and the one above does not clear it.
    if (app(AuthManager).cookieDomain(req)) {
      req.ctx().setCookie("access_token", "", {
        ...app(AuthManager).accessTokenCookieOptions(req, new Date(0)),
        domain: undefined,
      });
    }

    // No session is no longer a refusal: signing out is what a client does when
    // it wants none, and enforcing expiry makes "it ran out a moment ago" an
    // ordinary case — one whose cookie the old `401` left in place, with no way
    // to clear it. The hook still only ever sees a real user, as it did when
    // `Auth.user()` stood in front of it.
    if (session?.user) {
      session.user["extension"] = await config.extendSession(session.user);
      await config.onSignOut(session.user);
    }

    return {};
  }

  async forgotPassword(req = new ForgotPasswordRequest()) {
    const input = await req.input();
    const email = emailInput(input.get("email"));

    if (!email) {
      return {};
    }

    const { userProvider, config } = app(AuthManager);

    const user = await userProvider.findUserByEmailAddress(
      email,
      config.verifyEmail,
    );

    if (!user) {
      return {};
    }

    const token = await config.generateForgotPasswordToken(user);

    // TODO: Do not create token if already there is one that is valid
    // Prevent token spamming
    await userProvider.createPasswordResetToken({
      user,
      token,
    });

    await config.onForgotPassword(user, token);

    return {};
  }

  async resetPassword(req = new ResetPasswordRequest()) {
    const { userProvider, config } = app(AuthManager);
    const input = await req.input();
    const { password, token: rawToken } = input.toJSON();
    const token = nonEmptyString(rawToken);

    const passwordResetToken = token
      ? await userProvider.findPasswordResetToken({ token })
      : null;

    if (!passwordResetToken) {
      throw new ValidationError({
        token: ["Invalid token"],
      });
    }

    const isTokenExpired = Temporal.Instant.from(
      passwordResetToken.createdAt.toISOString(),
    )
      .add({ hours: 24 })
      .until(Temporal.Now.instant()).sign;

    if (isTokenExpired >= 0) {
      throw new ValidationError({
        token: ["Token expired"],
      });
    }

    await userProvider.deletePasswordResetToken({ token });

    const user = await userProvider.findUserByEmailAddress(
      passwordResetToken.user.email,
      config.verifyEmail,
    );

    if (!user) {
      throw new ValidationError({
        email: ["User not found"],
      });
    }

    const hashedPassword = await config.hashPassword(password);

    await userProvider.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await userProvider.deleteAllUserSessions(user.id);

    await config.onResetPassword(user);

    return {};
  }

  async changePassword(
    req = new HttpRequest<{ oldPassword: string; newPassword: string }>(),
  ) {
    const { userProvider, config } = app(AuthManager);
    const user = await Auth.user();
    const input = await req.input();
    const { oldPassword, newPassword } = input.toJSON();

    if (typeof newPassword !== "string") {
      throw new ValidationError({
        newPassword: ["Invalid password"],
      });
    }

    const stored = await userProvider.findUserByEmailAddress(
      user.email,
      config.verifyEmail,
    );

    const isPasswordValid =
      typeof oldPassword === "string" &&
      (await passwordMatches(config, oldPassword, stored?.password));

    if (!isPasswordValid) {
      throw new ValidationError({
        oldPassword: ["Incorrect password"],
      });
    }

    const hashedPassword = await config.hashPassword(newPassword);

    await userProvider.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await userProvider.deleteAllUserSessions(user.id);
    return {};
  }

  async oauthRedirect(req = new HttpRequest()) {
    const { provider } = req.params;
    const oauthProvider =
      app(AuthManager).config.oauthProviders[provider as string];

    if (!oauthProvider) {
      throw new Error(`Invalid provider: ${provider}`);
    }

    const secure = isSecureRequest(req.rawRequest);

    // The provider round trip drops our query string, so a `?redirect=` the
    // sign-in page forwarded onto this link waits in a cookie for the callback.
    // `Lax`, not the default `Strict`: the callback is a cross-site navigation
    // from the provider, and a strict cookie would not be sent on it.
    const intended = safeRedirectPath(req.search.get(INTENDED_URL_PARAM), "");
    if (intended) {
      req.ctx().setCookie(INTENDED_URL_COOKIE, encodeURIComponent(intended), {
        httpOnly: true,
        sameSite: "Lax",
        // By the scheme the client addressed, not by whether the host reads
        // as local: `localhost.evil.example` is not local, and a browser
        // drops a `Secure` cookie from a plain-http origin anyway.
        secure,
        maxAge: 60 * 10,
      });
    } else {
      // A `?redirect=` left from an earlier round trip in this browser must
      // not be taken for this one's.
      clearIntendedUrlCookie(req);
    }

    // The round trip's `state` and PKCE verifier, kept in this browser for
    // the callback to check (#822). See `oauth/oauthState.ts`.
    const { state, codeChallenge, cookieValue } = createOAuthState(provider as string);
    req.ctx().setCookie(oauthStateCookieName(secure), cookieValue, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });

    return {
      destination: await oauthProvider.getRedirectUrl(req, {
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      }),
    };
  }

  async oauthCallback(req = new HttpRequest()) {
    const { provider } = req.params;
    const auth = app(AuthManager);
    const { userProvider, config } = auth;
    const oauthProvider = config.oauthProviders[provider as string];

    // Read and delete the round trip's cookie first, whatever happens next:
    // a state is good for one callback.
    const secure = isSecureRequest(req.rawRequest);
    const stateCookie = oauthStateCookieName(secure);
    const storedState = req.cookies.get(stateCookie);
    if (storedState !== undefined && storedState !== null) {
      req.ctx().setCookie(stateCookie, "", {
        httpOnly: true,
        sameSite: "Lax",
        secure,
        maxAge: -1,
      });
    }

    if (!oauthProvider) {
      return this.oauthFailure(req, "unknown_provider");
    }

    // The provider says the user did not finish (`access_denied` when they
    // cancelled). There is no code to exchange.
    const providerError = req.search.get("error");
    if (providerError) {
      return this.oauthFailure(
        req,
        /^[a-z0-9_]{1,64}$/.test(providerError) ? providerError : "provider_error",
      );
    }

    // Accepted only for a round trip this browser started.
    const check = verifyOAuthState({
      provider: provider as string,
      cookieValue: storedState,
      returnedState: req.search.get("state"),
    });
    if ("reason" in check) {
      console.error(`Authentication error: OAuth callback refused (${check.reason})`);
      return this.oauthFailure(req, check.reason);
    }

    if (!req.search.get("code")) {
      return this.oauthFailure(req, "missing_code");
    }

    let profile: Awaited<ReturnType<typeof oauthProvider.onCallback>>;
    try {
      profile = await oauthProvider.onCallback(req, {
        state: check.payload.state,
        codeVerifier: check.payload.codeVerifier,
      });
    } catch (error) {
      if (error instanceof OAuthCallbackError) {
        return this.oauthFailure(req, error.code);
      }
      console.error("Authentication error: OAuth provider callback failed", error);
      return this.oauthFailure(req, "provider_error");
    }

    const { name, username, providerId, emailVerified } = profile ?? {};
    // Folded as the email-code flow folds it, so `Maria@Example.com` from the
    // provider is the `maria@example.com` who signed up with a code.
    const rawEmail = typeof profile?.email === "string" ? profile.email : undefined;
    const email = rawEmail ? normalizeEmail(rawEmail) : null;

    // Who this is, in order of how much each answer can be trusted:
    //
    // 1. The provider identity, `(provider, providerId)`. A returning account
    //    resolves here whatever has happened to its email or display name at
    //    the provider since — and the local user's email is not touched, so a
    //    provider-side change never moves the account to a different user.
    // 2. Otherwise the email, provided the provider has not said it is
    //    unverified: an existing user is signed in, and a new one is created.
    //    Either way the identity is linked, so the next callback takes step 1.
    //
    // A provider that returns no `providerId` only ever takes step 2, and has
    // no `SocialAccount` written — a row with no identity in it can never be
    // resolved by one.
    let user: User | null = providerId
      ? await userProvider.findUserBySocialAccount(provider, providerId)
      : null;

    let action: "signin" | "signup" = "signin";

    if (!user) {
      if (!email) {
        console.error(
          "Authentication error: No usable email returned from OAuth provider callback",
        );
        return this.oauthFailure(
          req,
          rawEmail ? "invalid_email" : providerId ? "missing_email" : "no_identity",
        );
      }

      // An address the provider has not verified proves nothing about who is
      // signing in, so it neither signs into the user who owns it nor creates
      // one. Google's guidance is to trust the email for account matching only
      // when `email_verified` is true.
      if (emailVerified === false) {
        console.error(
          "Authentication error: OAuth provider returned an unverified email",
        );
        return this.oauthFailure(req, "email_not_verified");
      }

      const locale = app(Translator).detectLocale(req);

      try {
        const resolved = await this.linkOAuthAccount({
          provider,
          providerId,
          email,
          rawEmail,
          name,
          username,
          locale,
          linkExisting: oauthProvider.linkByEmail !== false,
        });
        if (resolved === "account_exists") {
          console.error(
            `Authentication error: a ${provider} sign-in matched an existing user by email, and ${provider} does not link by email`,
          );
          return this.oauthFailure(req, "account_exists");
        }
        if (resolved) {
          user = resolved.user;
          action = resolved.action;
        }
      } catch (error) {
        // A concurrent callback for the same identity can win the race to
        // create the user or the link, and this one then fails on a unique
        // constraint. Recover only by *resolving the identity again*: the
        // error itself proves nothing — it could equally be a rolled-back
        // `onUserCreated` or a dropped connection — so anything that does not
        // now resolve is rethrown unchanged.
        const winner = providerId
          ? await userProvider.findUserBySocialAccount(provider, providerId)
          : null;
        if (!winner) throw error;
        user = winner;
      }

      if (!user) {
        return this.oauthFailure(req, "account_conflict");
      }
    }

    const session = await auth.createOrUpdateSessionV2({
      email: user.email,
      id: user.id,
    });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    if (action === "signup") {
      // `""`, and not a token, deliberately.
      //
      // This used to hand the hook `config.generateMagicLinkToken(email)`.
      // That function is a pure hash and nothing here persisted what it
      // returned — `userProvider.createMagicLinkToken`, which writes the
      // `MagicLinkToken` row, was never called — so the value resolved in
      // neither place a token can be looked up: not `User.verificationToken`,
      // which `createUser` above does not set, and not the `MagicLinkToken`
      // table. An application doing the obvious thing with the argument, and
      // mailing a confirmation link carrying it, sent every OAuth signup a link
      // that could not resolve, and it tested clean against email/password
      // signup, where the same parameter is the persisted verification token.
      //
      // There is nothing to verify on this path — the user arrives with
      // `emailVerifiedAt` already set — so "no token" is the honest value, and
      // it is the one the email path already passes under `verifyEmail: false`.
      // An app that does want to hand new OAuth users a magic link should mint
      // a persisted one with `Auth.createMagicLink(user.email)` from the hook.
      await config.onSignUp(user, "", req.search.toJSON());
    } else {
      await config.onSignIn(user, req.search.toJSON());
    }
    await notifyAuthenticated(auth.config, {
      session,
      user,
      isNewUser: action === "signup",
      method: "oauth",
      req,
    });

    // Where `oauthRedirect` was asked to return to, else `redirectPath`.
    const redirectTo = takeIntendedUrl(req) ?? config.redirectPath;

    return { session, redirectTo };
  }

  /**
   * A refused OAuth callback: the reason code and the page the sign-in was
   * meant to return to. With `auth.oauthFailurePath` set, the browser is
   * redirected there as `?error=<code>&redirect=<page>`; otherwise the
   * callback view renders with `{ session: null, error, redirectTo }`.
   *
   * Not a route — `protected` keeps it off the controller's public surface.
   */
  protected oauthFailure(
    req: HttpRequest<any, any>,
    error: string,
  ): { session: null; error: string; redirectTo: string | null } {
    const intended = takeIntendedUrl(req);
    const failurePath = app(AuthManager).config.oauthFailurePath;

    if (failurePath) {
      const target = safeRedirectPath(failurePath, "");
      if (target) {
        const url = new URL(target, "http://gemi.invalid");
        url.searchParams.set("error", error);
        if (intended) url.searchParams.set(INTENDED_URL_PARAM, intended);
        // A same-origin path, so `external` only skips `applyParams`, which
        // would read a `:` in the query as a route parameter.
        Redirect.external(`${url.pathname}${url.search}${url.hash}`);
      } else {
        console.error(
          `auth.oauthFailurePath must be a same-origin path, got ${JSON.stringify(failurePath)}`,
        );
      }
    }

    return { session: null, error, redirectTo: intended };
  }

  /**
   * Step 2 of `oauthCallback`: an identity that resolved to nobody, matched by
   * email. Returns null when the callback must be refused.
   *
   * Not a route — `protected` keeps it off the controller's public surface.
   */
  protected async linkOAuthAccount(args: {
    provider: string;
    providerId?: string;
    /** Normalised: trimmed and lower-cased. */
    email: string;
    /** As the provider returned it, for users stored before emails were normalised. */
    rawEmail?: string;
    name?: string;
    username?: string;
    locale: string;
    /**
     * Whether an existing user with this email is signed in (and the identity
     * linked to them). `false` for a provider with `linkByEmail: false`: the
     * callback is refused with `account_exists` instead.
     */
    linkExisting?: boolean;
  }): Promise<{ user: User; action: "signin" | "signup" } | "account_exists" | null> {
    const { provider, providerId, email, rawEmail, name, username, locale } = args;
    const { userProvider, config } = app(AuthManager);

    const socialAccount = (userId: number) => ({
      provider,
      userId,
      email,
      // The provider's handle where it has one (X). Google has none, and the
      // display name is not one: it is neither unique nor stable, and it was
      // what made two Google users called the same thing collide.
      username,
      providerId,
      expiresAt: new Date(),
      accessToken: "",
      refreshToken: "",
    });

    // The normalised address first. An account an earlier OAuth sign-up
    // stored exactly as the provider spelled it is still found by that
    // spelling, rather than duplicated.
    let existing = await userProvider.findUserByEmailAddress(email, false);
    const asReturned = rawEmail?.trim();
    if (!existing && asReturned && asReturned !== email) {
      existing = await userProvider.findUserByEmailAddress(asReturned, false);
    }

    if (existing) {
      // The provider does not vouch for the address: the same email is not
      // proof that this is the same person, so nothing is signed in or linked.
      if (args.linkExisting === false) return "account_exists";

      if (!providerId) return { user: existing, action: "signin" };

      const accounts = await userProvider.findSocialAccounts(
        existing.id,
        provider,
      );

      // Linked since step 1 looked — a concurrent callback for this same
      // account committed in between.
      if (accounts.some((account) => account.providerId === providerId)) {
        return { user: existing, action: "signin" };
      }

      // This user is already linked to a *different* account at this
      // provider. The email matching is not enough to move the link: it is the
      // same address, not the same account (a deleted and re-created Workspace
      // user, an address that changed hands). Refuse, and leave it to the
      // application to unlink the old row if re-linking is intended.
      if (accounts.some((account) => account.providerId)) {
        console.error(
          `Authentication error: user ${existing.id} is already linked to a different ${provider} account`,
        );
        return null;
      }

      // A row from before identities were recorded. It was made for this user
      // when they signed up through this provider by this email, so recording
      // the identity on it grants nothing the email match did not already.
      const legacy = accounts[0];
      if (legacy) {
        if (!(await userProvider.claimSocialAccount(legacy, providerId))) {
          // Someone else claimed it between the read and the write. Throwing
          // hands it to the caller's recovery, which signs in only if the
          // claim was for this same identity.
          throw new Error(`${provider} account link changed concurrently`);
        }
      } else {
        await userProvider.createSocialAccount(socialAccount(existing.id));
      }

      return { user: existing, action: "signin" };
    }

    // Same shape as `signUp`: the user, the row that has to exist beside it,
    // and `onUserCreated`, in one transaction. The social account in
    // particular has a foreign key onto the user — created outside, a rolled
    // back user would leave it pointing at nothing.
    const user = await userProvider.transaction(async () => {
      const created = await userProvider.createUser({
        email,
        name,
        locale,
        emailVerifiedAt: new Date(),
      });

      if (providerId) {
        await userProvider.createSocialAccount(socialAccount(created.id));
      }

      await config.onUserCreated(created);

      return created;
    });

    return { user, action: "signup" };
  }

  async createMagicLinkToken(req = new HttpRequest<{ email: string }>()) {
    const input = await req.input();
    const email = foldEmail(input.get("email"));
    const auth = app(AuthManager);
    const { uniformMagicLinkResponse, requestLimit } = auth.config.emailCode;

    await enforceCodeRateLimits("request", email, req, requestLimit);

    if (!email) {
      return { email: null };
    }

    const { user, pin, token } = await auth.createMagicLinkToken(email);

    if (user) {
      await auth.config.onMagicLinkCreated(user, { email, pin, token });
      return {
        email,
      };
    }

    // `{ email: null }` says the address has no account; clients built on
    // that keep it unless the app opts into the uniform answer (#708).
    return { email: uniformMagicLinkResponse ? email : null };
  }

  /**
   * `POST /auth/email-code` `{ email }`: sends a one-time code (#708).
   *
   * Always `{ ok: true }`, whether or not the address has a user and whether
   * or not one would be created, so the answer says nothing about accounts.
   * An address that gets no code (unknown, with `createUser` off) is sent
   * nothing and answered the same.
   */
  async requestEmailCode(req = new HttpRequest<{ email: string }>()) {
    const auth = app(AuthManager);
    const config = auth.config.emailCode;
    if (!config.enabled) {
      throw new RequestBreakerError("Not found", { status: 404 });
    }

    const input = await req.input();
    const email = normalizeEmail(input.get("email"));
    await enforceCodeRateLimits("request", email, req, config.requestLimit);
    if (!email) {
      throw new ValidationError({ email: ["Invalid email"] });
    }

    const user = await auth.userProvider.findUserByEmailAddress(email, false);
    if (user || config.createUser) {
      const { pin, token } = await auth.issueOneTimeCode(email, config.length);
      await config.send({ email, code: pin, token, isNewUser: !user, req });
    }

    return { ok: true as const };
  }

  /**
   * `POST /auth/email-code/verify` `{ email, code, name? }`: signs in with a
   * code from `/auth/email-code`, creating the user first when there is none
   * and `createUser` is on. Answers `{ session, isNewUser }` and sets the
   * `access_token` cookie.
   *
   * A wrong, expired or missing code is a `ValidationError` on `code`
   * (`invalid_code`); the guess past `maxAttempts` burns the code and is
   * `too_many_attempts`.
   */
  async verifyEmailCode(
    req = new HttpRequest<{ email: string; code: string; name?: string }>(),
  ) {
    const auth = app(AuthManager);
    const { userProvider, config } = auth;
    if (!config.emailCode.enabled) {
      throw new RequestBreakerError("Not found", { status: 404 });
    }

    const input = await req.input();
    const { email: rawEmail, code: rawCode, name } = input.toJSON();
    const email = normalizeEmail(rawEmail);
    const code = pinValue(rawCode);
    await enforceCodeRateLimits("verify", email, req, config.emailCode.verifyLimit);
    if (!email || !code) {
      throw new ValidationError({ code: ["invalid_code"] });
    }

    const result = await auth.verifyOneTimeCode(email, code, { claim: false });
    if (result.status === "too_many_attempts") {
      throw new ValidationError({ code: ["too_many_attempts"] });
    }
    if (result.status !== "ok") {
      throw new ValidationError({ code: ["invalid_code"] });
    }
    const row = result.row;

    let user = await userProvider.findUserByEmailAddress(email, false);
    let isNewUser = false;

    if (user) {
      if (!(await userProvider.claimMagicLinkToken(row.id))) {
        throw new ValidationError({ code: ["invalid_code"] });
      }
      await userProvider.verifyUser(email);
    } else if (config.emailCode.createUser) {
      const locale = app(Translator).detectLocale(req);
      try {
        // Claimed inside the transaction: a rolled-back `onUserCreated` puts
        // the code back, and of two requests with the same code only the one
        // that deletes the row creates a user.
        user = await userProvider.transaction(async () => {
          if (!(await userProvider.claimMagicLinkToken(row.id))) {
            throw new CodeAlreadyClaimed();
          }
          const created = await userProvider.createUser({
            email,
            name: typeof name === "string" ? name.trim() : "",
            emailVerifiedAt: new Date(),
            locale,
          });
          await config.onUserCreated(created);
          return created;
        });
        isNewUser = true;
      } catch (error) {
        if (error instanceof CodeAlreadyClaimed) {
          throw new ValidationError({ code: ["invalid_code"] });
        }
        throw error;
      }
    } else {
      // A row for an address with no user, left from when `createUser` was on.
      await userProvider.claimMagicLinkToken(row.id);
      throw new ValidationError({ code: ["invalid_code"] });
    }

    const session = await auth.createOrUpdateSessionV2({ email, id: user.id });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await config.onSignIn(session, req.search.toJSON());
    await notifyAuthenticated(auth.config, { session, isNewUser, method: "email-code", req });

    return { session, isNewUser };
  }
}
