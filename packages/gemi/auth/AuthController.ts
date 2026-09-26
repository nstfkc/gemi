import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { AuthorizationError } from "../http/errors";
import { Auth } from "../facades";
import { app } from "../foundation/app";
import { Translator } from "../i18n/Translator";
import type { Invitation, User } from "./types";
import { AuthManager } from "./AuthManager";
import { INTENDED_URL_PARAM, isSecureRequest, safeRedirectPath } from "../utils/intendedUrl";

/** Holds a `?redirect=` across the OAuth provider round trip. */
const INTENDED_URL_COOKIE = "intended_url";

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

    const user = await userProvider.findUserByVerificationToken(
      input.get("token"),
    );

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
    const token = req.search.get("token");
    const email = decodeURIComponent(req.search.get("email"))
      .toLowerCase()
      .trim();

    let magicLink = null;

    try {
      magicLink = await userProvider.findUserMagicLinkToken({
        email,
        token,
      });
    } catch (err) {
      console.log(err);
      return { error: JSON.stringify(err) };
    }

    if (!magicLink) {
      return { error: "Invalid token" };
    }

    await userProvider.verifyUser(email);
    await userProvider.deleteMagicLinkToken(email);
    const session = await auth.createOrUpdateSession({ email });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(session, req.search.toJSON());

    return { session };
  }

  async signInWithPinV2(
    req = new HttpRequest<{ email: string; pin: string }>(),
  ) {
    const auth = app(AuthManager);
    const { userProvider } = auth;
    const input = await req.input();
    const { email: _email, pin } = input.toJSON();
    const email = _email.toLowerCase().trim();

    const magicLinkToken = await userProvider.findUserMagicLinkToken({
      email,
      pin,
    });

    if (!magicLinkToken) {
      throw new ValidationError({
        pin: ["Invalid pin"],
      });
    }

    await userProvider.deleteMagicLinkToken(email);
    await userProvider.verifyUser(email);

    const session = await auth.createOrUpdateSessionV2({ email });

    req
      .ctx()
      .setCookie(
        "access_token",
        session.token,
        app(AuthManager).accessTokenCookieOptions(req, session.expiresAt),
      );

    await auth.config.onSignIn(session, req.search.toJSON());

    return session;
  }

  async signInWithPin(req = new HttpRequest<{ email: string; pin: string }>()) {
    const auth = app(AuthManager);
    const { userProvider } = auth;
    const input = await req.input();
    const { email: _email, pin } = input.toJSON();
    const email = _email.toLowerCase().trim();

    const magicLinkToken = await userProvider.findUserMagicLinkToken({
      email,
      pin,
    });

    if (!magicLinkToken) {
      throw new ValidationError({
        pin: ["Invalid pin"],
      });
    }

    await userProvider.deleteMagicLinkToken(email);
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

    if (!user) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const isPasswordValid = await auth.config.verifyPassword(
      password,
      user.password,
    );

    if (!isPasswordValid) {
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

    if (!user) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const isPasswordValid = await auth.config.verifyPassword(
      password,
      user.password,
    );

    if (!isPasswordValid) {
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
    } = input.toJSON();
    const email = _email.toLowerCase().trim();

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
    const token = req.cookies.get("access_token");

    const user = await Auth.user();

    const { userProvider, config } = app(AuthManager);

    await userProvider.deleteSession({ token });

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

    await config.onSignOut(user);

    return {};
  }

  async forgotPassword(req = new ForgotPasswordRequest()) {
    const input = await req.input();
    const email = input.get("email").toLowerCase().trim();

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
    const { password, token } = input.toJSON();

    const passwordResetToken = await userProvider.findPasswordResetToken({
      token,
    });

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

    const { password } = await userProvider.findUserByEmailAddress(
      user.email,
      config.verifyEmail,
    );

    const isPasswordValid = await config.verifyPassword(oldPassword, password);

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
        secure: isSecureRequest(req.rawRequest),
        maxAge: 60 * 10,
      });
    }

    return {
      destination: await oauthProvider.getRedirectUrl(req),
    };
  }

  async oauthCallback(req = new HttpRequest()) {
    const { provider } = req.params;
    const auth = app(AuthManager);
    const { userProvider, config } = auth;
    const oauthProvider = config.oauthProviders[provider as string];

    const { email, name, username, providerId } =
      await oauthProvider.onCallback(req);

    // Who this is, in order of how much each answer can be trusted:
    //
    // 1. The provider identity, `(provider, providerId)`. A returning account
    //    resolves here whatever has happened to its email or display name at
    //    the provider since — and the local user's email is not touched, so a
    //    provider-side change never moves the account to a different user.
    // 2. Otherwise the email, exactly as before: an existing user is signed in,
    //    and a new one is created. Either way the identity is linked, so the
    //    next callback takes step 1.
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
          "Authentication error: No email returned from OAuth provider callback",
        );
        return {
          session: null,
        };
      }

      const locale = app(Translator).detectLocale(req);

      try {
        const resolved = await this.linkOAuthAccount({
          provider,
          providerId,
          email,
          name,
          username,
          locale,
        });
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
        return {
          session: null,
        };
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

    // Where `oauthRedirect` was asked to return to, else `redirectPath`.
    // Checked again on the way out: a cookie is client-writable too.
    const stashed = req.cookies.get(INTENDED_URL_COOKIE);
    let redirectTo = config.redirectPath;
    if (stashed) {
      try {
        redirectTo = safeRedirectPath(decodeURIComponent(stashed), redirectTo);
      } catch {}
      req.ctx().setCookie(INTENDED_URL_COOKIE, "", { maxAge: -1 });
    }

    return { session, redirectTo };
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
    email: string;
    name?: string;
    username?: string;
    locale: string;
  }): Promise<{ user: User; action: "signin" | "signup" } | null> {
    const { provider, providerId, email, name, username, locale } = args;
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

    const existing = await userProvider.findUserByEmailAddress(email, false);

    if (existing) {
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
    const email = input.get("email").toLowerCase().trim();
    const auth = app(AuthManager);
    const { user, pin, token } = await auth.createMagicLinkToken(email);

    if (user) {
      await auth.config.onMagicLinkCreated(user, { email, pin, token });
      return {
        email,
      };
    }

    return { email: null };
  }
}
