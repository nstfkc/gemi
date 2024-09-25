import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { KernelContext } from "../kernel/KernelContext";
import { Auth } from "../facades";
import type { IAuthenticationAdapter, User } from "./adapters/types";
import { BlankAdapter } from "./adapters/blank";
import { AuthorizationError } from "../http/errors";
import { ValidationError } from "../http";

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
  provider = KernelContext.getStore().authenticationServiceContainer.provider;

  async me() {
    const user = await Auth.user();

    if (!user) {
      throw new AuthorizationError();
    }

    return user;
  }

  async signIn(req = new SignInRequest()) {
    const input = await req.input.call(req);
    const { email, password } = input.toJSON();

    const user = await this.provider.adapter.findUserByEmailAddress(email);

    if (!user) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const isPasswordValid = await this.provider.verifyPassword(
      password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new ValidationError({
        invalid_credentials: ["Invalid credentials"],
      });
    }

    const userAgent = req.headers.get("User-Agent");

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${user.email}${userAgent}`);

    const token = hasher.digest("hex");

    let session = await this.provider.adapter.findSession({
      token,
      userAgent:
        process.env.NODE_ENV === "development"
          ? "local"
          : req.headers.get("User-Agent"),
    });

    if (!session) {
      session = await this.provider.adapter.createSession({
        token,
        userId: user.id,
        userAgent:
          process.env.NODE_ENV === "development"
            ? "local"
            : req.headers.get("User-Agent"),
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.provider.sessionExpiresInHours })
            .toString(),
        ),
        absoluteExpiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.provider.sessionAbsoluteExpiresInHours })
            .toString(),
        ),
      });
    } else {
      session = await this.provider.adapter.updateSession({
        token,
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.provider.sessionExpiresInHours })
            .toString(),
        ),
      });
    }

    req.ctx.setCookie("access_token", session.token, {
      expires: session.expiresAt,
    });

    await this.provider.onSignIn(user);

    return user;
  }

  async signUp(req = new SignUpRequest()) {
    const input = await req.input();
    const { email, password, name } = input.toJSON();

    const user = await this.provider.adapter.findUserByEmailAddress(email);

    if (user) {
      throw new ValidationError({
        email: ["Email address already exists"],
      });
    }

    const hashedPassword = await this.provider.hashPassword(password);

    const newUser = await this.provider.adapter.createUser({
      email,
      name,
      password: hashedPassword,
    });

    await this.provider.onSignUp(newUser);

    return newUser;
  }

  async signOut(req = new HttpRequest()) {
    const token = req.cookies.get("access_token");

    const user = await Auth.user();

    await this.provider.adapter.deleteSession({ token });

    req.ctx.setCookie("access_token", "", {
      expires: new Date(0),
    });

    await this.provider.onSignOut(user);

    return {};
  }

  async forgotPassword(req = new ForgotPasswordRequest()) {
    const input = await req.input();
    const { email } = input.toJSON();

    const user = await this.provider.adapter.findUserByEmailAddress(email);

    if (!user) {
      return {};
    }

    const token = await this.provider.generateForgotPasswordToken(user);

    // TODO: Do not create token if already there is one that is valid
    // Prevent token spamming
    await this.provider.adapter.createPasswordResetToken({
      user,
      token,
    });

    await this.provider.onForgotPassword(user, token);

    return {};
  }

  async resetPassword(req = new ResetPasswordRequest()) {
    const input = await req.input();
    const { password, token } = input.toJSON();

    const passwordResetToken =
      await this.provider.adapter.findPasswordResetToken({ token });

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

    await this.provider.adapter.deletePasswordResetToken({ token });

    const user = await this.provider.adapter.findUserByEmailAddress(
      passwordResetToken.user.email,
    );

    if (!user) {
      throw new ValidationError({
        email: ["User not found"],
      });
    }

    const hashedPassword = await this.provider.hashPassword(password);

    await this.provider.adapter.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await this.provider.adapter.deleteAllUserSessions(user.id);

    await this.provider.onResetPassword(user);

    return {};
  }

  async changePassword(
    req = new HttpRequest<{ oldPassword: string; newPassword: string }>(),
  ) {
    const user = await Auth.user();
    const input = await req.input();
    const { oldPassword, newPassword } = input.toJSON();

    const { password } = await this.provider.adapter.findUserByEmailAddress(
      user.email,
    );

    const isPasswordValid = await this.provider.verifyPassword(
      oldPassword,
      password,
    );

    if (!isPasswordValid) {
      throw new ValidationError({
        oldPassword: ["Incorrect password"],
      });
    }

    const hashedPassword = await this.provider.hashPassword(newPassword);

    await this.provider.adapter.updateUserPassword({
      id: user.id,
      password: hashedPassword,
    });

    await this.provider.adapter.deleteAllUserSessions(user.id);
    return {};
  }
}

export class AuthApiRouter extends ApiRouter {
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
    "/change-password": this.post(AuthController, "changePassword"),
    "/me": this.get(AuthController, "me"),
  };
}

export class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
    "/reset-password": this.view("auth/ResetPassword"),
    "/forgot-password": this.view("auth/ForgotPassword"),
  };
}

export class AuthenticationServiceProvider {
  basePath = "/auth";

  sessionExpiresInHours = 24;
  sessionAbsoluteExpiresInHours = 24 * 7 * 4;

  // @ts-ignore
  adapter: IAuthenticationAdapter = new BlankAdapter();

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

  extendSession<T extends User>(_user: T): Promise<any> | any {
    return {};
  }

  onSignUp<T extends User>(_user: T): Promise<void> | void {}
  onSignIn<T extends User>(_user: T): Promise<void> | void {}
  onSignOut<T extends User>(_user: T): Promise<void> | void {}
  onForgotPassword<T extends User>(
    _user: T,
    _verificationToken: string,
  ): Promise<void> | void {}
  onResetPassword<T extends User>(_user: T): Promise<void> | void {}
}
