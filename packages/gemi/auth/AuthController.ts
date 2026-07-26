import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ValidationError } from "../http";
import { AuthorizationError } from "../http/errors";
import { Auth } from "../facades";
import { app } from "../foundation/app";
import { Translator } from "../i18n/Translator";
import type { Invitation, User } from "./adapters/types";
import { AuthManager } from "./AuthManager";

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

    const url = new URL(req.rawRequest.url);
    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

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

    const url = new URL(req.rawRequest.url);
    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

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

    const url = new URL(req.rawRequest.url);
    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

    await auth.config.onSignIn(session, req.search.toJSON());

    return { session };
  }

  async signInV2(req = new SignInRequest()) {
    const url = new URL(req.rawRequest.url);
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

    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

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

    const url = new URL(req.rawRequest.url);
    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

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

      if (invitation) {
        await userProvider.deleteInvitationById(invitationId);
      }
    }

    let newUser: User;
    let verificationToken: string;

    if (invitation) {
      newUser = await userProvider.createUser({
        email,
        name,
        password: hashedPassword,
        emailVerifiedAt: new Date(),
        locale,
      });
      await userProvider.createAccount({
        organizationId: invitation.organizationId,
        userId: newUser.id,
        organizationRole: invitation.role,
      });
    } else {
      verificationToken = await config.generateEmailVerificationToken(email);

      newUser = await userProvider.createUser({
        email,
        name,
        password: hashedPassword,
        verificationToken,
        locale,
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

    const url = new URL(req.rawRequest.url);
    req.ctx().setCookie("access_token", "", {
      expires: new Date(0),
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
    });

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

    return {
      destination: await oauthProvider.getRedirectUrl(req),
    };
  }

  async oauthCallback(req = new HttpRequest()) {
    const { provider } = req.params;
    const auth = app(AuthManager);
    const { userProvider, config } = auth;
    const oauthProvider = config.oauthProviders[provider as string];

    const { email, name } = await oauthProvider.onCallback(req);

    if (!email) {
      console.error(
        "Authentication error: No email returned from OAuth provider callback",
      );
      return {
        session: null,
      };
    }

    let user = await userProvider.findUserByEmailAddress(email, false);

    const locale = app(Translator).detectLocale(req);

    let action: "signin" | "signup" = "signin";

    if (!user) {
      action = "signup";
      user = await userProvider.createUser({
        email,
        name,
        locale,
        emailVerifiedAt: new Date(),
      });

      // TODO: fix missing fields
      await userProvider.createSocialAccount({
        provider,
        userId: user.id,
        email,
        username: name,
        providerId: "",
        expiresAt: new Date(),
        accessToken: "",
        refreshToken: "",
      });
    }

    const session = await auth.createOrUpdateSessionV2({
      email: user.email,
      id: user.id,
    });

    const url = new URL(req.rawRequest.url);

    req.ctx().setCookie("access_token", session.token, {
      secure: !url.origin.includes("localhost"),
      httpOnly: true,
      expires: session.expiresAt,
    });

    if (action === "signup") {
      const magicLink = await config.generateMagicLinkToken(email);
      await config.onSignUp(user, magicLink, req.search.toJSON());
    } else {
      await config.onSignIn(user, req.search.toJSON());
    }

    return { session };
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
