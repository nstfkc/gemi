import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Auth } from "../facades";
import type {
  IAuthenticationAdapter,
  Invitation,
  User,
} from "./adapters/types";
import { BlankAdapter } from "./adapters/blank";
import { AuthorizationError } from "../http/errors";
import { ValidationError } from "../http";
import { ServiceProvider } from "../services/ServiceProvider";
import { AuthenticationServiceContainer } from "./AuthenticationServiceContainer";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { OAuthProvider } from "./oauth/OAuthProvider";

class SignInRequest extends HttpRequest<
  {
    email: string;
    password: string;
  },
  {}
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

class SignUpRequest extends HttpRequest<
  {
    name: string;
    email: string;
    password: string;
    invitationId?: string;
  },
  {}
> {
  schema = {
    name: {
      string: "Invalid name",
      required: "Name is required",
      "min:2": "Name must be at least 3 characters",
    },
    email: {
      string: "Invalid email",
      required: "Email is required",
      email: "Invalid email",
    },
    password: {
      required: "Password is required",
      "min:8": "Password must be at least 8 characters",
    },
  };
}

class ForgotPasswordRequest extends HttpRequest<
  {
    email: string;
  },
  {}
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
  {}
> {
  schema = {
    password: {
      required: "Password is required",
      password: "Invalid password",
    },
  };
}

class AuthController extends Controller {
  provider = AuthenticationServiceContainer.use()?.provider;

  async me() {
    const user = await Auth.user();

    if (!user) {
      throw new AuthorizationError();
    }

    return user;
  }

  async verifyEmail(req = new HttpRequest<{ token: string }>()) {
    const input = await req.input();
    const authProvider = AuthenticationServiceContainer.use()?.provider;

    const user = await authProvider.adapter.findUserByVerificationToken(
      input.get("token"),
    );

    if (!user) {
      return { email: null };
    }

    await authProvider.adapter.verifyUser(user.email);

    if (user) {
      return {
        email: user.email,
      };
    }

    return { email: null };
  }

  async signInWithMagicLink(req = new HttpRequest()) {
    const container = AuthenticationServiceContainer.use();
    const authProvider = container.provider;
    const token = req.search.get("token");
    const email = decodeURIComponent(req.search.get("email"));

    let magicLink = null;

    try {
      magicLink = await authProvider.adapter.findUserMagicLinkToken({
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

    await authProvider.adapter.verifyUser(email);
    await authProvider.adapter.deleteMagicLinkToken(email);
    const session = await container.createOrUpdateSession({ email });

    req.ctx().setCookie("access_token", session.token, {
      expires: session.absoluteExpiresAt,
    });

    await authProvider.onSignIn(session);

    return { session };
  }

  async signInWithPin(req = new HttpRequest<{ email: string; pin: string }>()) {
    const container = AuthenticationServiceContainer.use();
    const authProvider = container.provider;
    const input = await req.input();
    const { email, pin } = input.toJSON();

    const magicLinkToken = await authProvider.adapter.findUserMagicLinkToken({
      email,
      pin,
    });

    if (!magicLinkToken) {
      throw new ValidationError({
        pin: ["Invalid pin"],
      });
    }

    await authProvider.adapter.deleteMagicLinkToken(email);
    await authProvider.adapter.verifyUser(email);

    const session = await container.createOrUpdateSession({ email });

    req.ctx().setCookie("access_token", session.token, {
      expires: session.absoluteExpiresAt,
    });

    await authProvider.onSignIn(session);

    return { session };
  }

  async signIn(req = new SignInRequest()) {
    const input = await req.input();
    if (process.env.DEBUG === "verbose") {
      console.log("signIn", input.toJSON());
    }
    const { email, password } = input.toJSON();

    const authProvider = AuthenticationServiceContainer.use().provider;

    const user = await authProvider.adapter.findUserByEmailAddress(
      email,
      authProvider.verifyEmail,
    );

    if (!user) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const isPasswordValid = await authProvider.verifyPassword(
      password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const session =
      await AuthenticationServiceContainer.use().createOrUpdateSession({
        email: user.email,
        id: user.id,
      });

    req.ctx().setCookie("access_token", session.token, {
      expires: session.absoluteExpiresAt,
    });

    await authProvider.onSignIn(user);

    const { password: _, ...rest } = user;

    return rest;
  }

  async signUp(req = new SignUpRequest()) {
    const input = await req.input();
    const { email, password, name, invitationId } = input.toJSON();

    const authProvider = AuthenticationServiceContainer.use().provider;
    const user = await authProvider.adapter.findUserByEmailAddress(
      email,
      false,
    );

    if (user) {
      throw new ValidationError({
        email: ["Email address already exists"],
      });
    }

    const hashedPassword = await authProvider.hashPassword(password);

    const locale = I18nServiceContainer.use().detectLocale(req);

    let invitation: Invitation;
    if (invitationId) {
      invitation = await authProvider.adapter.findInvitation(
        invitationId,
        email,
      );

      if (invitation) {
        await authProvider.adapter.deleteInvitationById(invitationId);
      }
    }

    let newUser: User;
    let verificationToken: string;

    if (invitation) {
      newUser = await authProvider.adapter.createUser({
        email,
        name,
        password: hashedPassword,
        emailVerifiedAt: new Date(),
        locale,
      });
      await authProvider.adapter.createAccount({
        organizationId: invitation.organizationId,
        userId: newUser.id,
        organizationRole: invitation.role,
      });
    } else {
      verificationToken =
        await authProvider.generateEmailVerificationToken(email);

      newUser = await authProvider.adapter.createUser({
        email,
        name,
        password: hashedPassword,
        verificationToken,
        locale,
      });
    }

    await authProvider.onSignUp(newUser, verificationToken);

    return newUser;
  }

  async signOut(req = new HttpRequest()) {
    const token = req.cookies.get("access_token");

    const user = await Auth.user();

    const authProvider = AuthenticationServiceContainer.use().provider;

    await authProvider.adapter.deleteSession({ token });

    req.ctx().setCookie("access_token", "", {
      expires: new Date(0),
    });

    await authProvider.onSignOut(user);

    return {};
  }

  async forgotPassword(req = new ForgotPasswordRequest()) {
    const input = await req.input();
    const { email } = input.toJSON();

    const authProvider = AuthenticationServiceContainer.use().provider;

    const user = await authProvider.adapter.findUserByEmailAddress(
      email,
      authProvider.verifyEmail,
    );

    if (!user) {
      return {};
    }

    const token = await authProvider.generateForgotPasswordToken(user);

    // TODO: Do not create token if already there is one that is valid
    // Prevent token spamming
    await authProvider.adapter.createPasswordResetToken({
      user,
      token,
    });

    await authProvider.onForgotPassword(user, token);

    return {};
  }

  async resetPassword(req = new ResetPasswordRequest()) {
    const authProvider = AuthenticationServiceContainer.use().provider;
    const input = await req.input();
    const { password, token } = input.toJSON();

    const passwordResetToken =
      await authProvider.adapter.findPasswordResetToken({ token });

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

    await authProvider.adapter.deletePasswordResetToken({ token });

    const user = await authProvider.adapter.findUserByEmailAddress(
      passwordResetToken.user.email,
      authProvider.verifyEmail,
    );

    if (!user) {
      throw new ValidationError({
        email: ["User not found"],
      });
    }

    const hashedPassword = await authProvider.hashPassword(password);

    await authProvider.adapter.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await authProvider.adapter.deleteAllUserSessions(user.id);

    await authProvider.onResetPassword(user);

    return {};
  }

  async changePassword(
    req = new HttpRequest<{ oldPassword: string; newPassword: string }>(),
  ) {
    const authProvider = AuthenticationServiceContainer.use().provider;
    const user = await Auth.user();
    const input = await req.input();
    const { oldPassword, newPassword } = input.toJSON();

    const { password } = await authProvider.adapter.findUserByEmailAddress(
      user.email,
      authProvider.verifyEmail,
    );

    const isPasswordValid = await authProvider.verifyPassword(
      oldPassword,
      password,
    );

    if (!isPasswordValid) {
      throw new ValidationError({
        oldPassword: ["Incorrect password"],
      });
    }

    const hashedPassword = await authProvider.hashPassword(newPassword);

    await authProvider.adapter.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await authProvider.adapter.deleteAllUserSessions(user.id);
    return {};
  }

  async oauthRedirect(req = new HttpRequest()) {
    const { provider } = req.params;
    const oauthProvider =
      AuthenticationServiceContainer.use().provider.oauthProviders[
        provider as string
      ];

    if (!oauthProvider) {
      throw new Error(`Invalid provider: ${provider}`);
    }

    return {
      destination: await oauthProvider.getRedirectUrl(req),
    };
  }

  async oauthCallback(req = new HttpRequest()) {
    const { provider } = req.params;
    const container = AuthenticationServiceContainer.use();
    const authProvider = container.provider;
    const oauthProvider = authProvider.oauthProviders[provider as string];
    const { email, name, username, providerId } =
      await oauthProvider.onCallback(req);

    if (!username && !email) {
      throw new Error("Email or username is required");
    }

    const identifier = email ?? `${username}:${provider}`;

    let user = await authProvider.adapter.findUserByEmailAddress(
      identifier,
      false,
    );

    const locale = I18nServiceContainer.use().detectLocale(req);

    if (!user) {
      user = await authProvider.adapter.createUser({
        email: identifier,
        name,
        locale,
        emailVerifiedAt: new Date(),
      });

      // TODO: fix missing fields
      await authProvider.adapter.createSocialAccount({
        provider,
        userId: user.id,
        email: identifier,
        username,
        providerId,
        expiresAt: new Date(),
        accessToken: "",
        refreshToken: "",
      });
    }

    const session = await container.createOrUpdateSession({
      email: user.email,
      id: user.id,
    });

    req.ctx().setCookie("access_token", session.token, {
      expires: session.expiresAt,
    });

    await authProvider.onSignIn(user);

    return {
      destination: authProvider.redirectPath,
    };
  }

  async createMagicLinkToken(req = new HttpRequest<{ email: string }>()) {
    const input = await req.input();
    const { email } = input.toJSON();
    const container = AuthenticationServiceContainer.use();
    const provider = container.provider;
    const { user, pin, token } = await container.createMagicLinkToken(email);

    await provider.onMagicLinkCreated(user, { email, pin, token });

    return {
      email,
    };
  }
}

class OAuthViewRouter extends ViewRouter {
  routes = {
    "/:provider": this.redirect([AuthController, "oauthRedirect"]),
    "/:provider/callback": this.redirect([AuthController, "oauthCallback"]),
  };
}

export class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in/magic-link": this.view("auth/MagicLinkSignIn", [
      AuthController,
      "signInWithMagicLink",
    ]),
    "/oauth": OAuthViewRouter,
  };
}

export class AuthApiRouter extends ApiRouter {
  middlewares = ["cache:private"];
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
    "/change-password": this.post(AuthController, "changePassword"),
    "/verify-email": this.post(AuthController, "verifyEmail"),
    "/me": this.get(AuthController, "me").middleware(["auth"]),
    "/magic-link": this.post(AuthController, "createMagicLinkToken"),
    "/sign-in-with-pin": this.post(AuthController, "signInWithPin"),
  };
}

export class AuthenticationServiceProvider extends ServiceProvider {
  basePath = "/auth";
  verifyEmail = true;
  redirectPath = "/dashboard";

  sessionExpiresInHours = 24;
  sessionAbsoluteExpiresInHours = 24 * 7 * 4;

  // @ts-ignore
  adapter: IAuthenticationAdapter = new BlankAdapter();

  oauthProviders: Record<string, OAuthProvider> = {};

  boot() {}

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return await Bun.password.verify(password, hash);
  }

  async hashPassword(password: string): Promise<string> {
    return await Bun.password.hash(password);
  }

  async generateForgotPasswordToken(user: User): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${user.email}${Date.now()}`);
    return hasher.digest("hex");
  }

  generateEmailVerificationToken(email: string): Promise<string> | string {
    if (!this.verifyEmail) {
      return "";
    }
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${email}${Date.now()}`);
    return hasher.digest("hex");
  }

  generateMagicLinkToken(email: string): Promise<string> | string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${email}${Date.now()}`);
    return hasher.digest("hex");
  }

  extendSession<T extends User>(_user: T): Promise<any> | any {
    return {};
  }

  onSignUp<T extends User>(
    _user: T,
    _verificationToken?: string,
  ): Promise<void> | void {}
  onSignIn(_session: any): Promise<void> | void {}
  onSignOut(_session: any): Promise<void> | void {}
  onForgotPassword(
    _user: any,
    _verificationToken: string,
  ): Promise<void> | void {}
  onResetPassword(_session: any): Promise<void> | void {}
  onMagicLinkCreated(
    _session: any,
    _args: { email: string; token: string; pin: string },
  ): Promise<void> | void {
    return;
  }
}
