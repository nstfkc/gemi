import { Temporal } from "temporal-polyfill";

import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { KernelContext } from "../kernel/KernelContext";
import { Auth } from "../facades";
import type { IAuthenticationAdapter, User } from "./adapters/types";
import { BlankAdapter } from "./adapters/blank";
import { AuthorizationError, AuthenticationError } from "../http/errors";
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
      required: true,
      "min:2": "Name must be at least 3 characters",
    },
    email: {
      string: "Invalid email",
      required: true,
      email: "Invalid email",
    },
    password: {
      required: true,
      "min:8": "Password must be at least 8 characters",
    },
  };
}

class AuthController extends Controller {
  requests = {
    signUp: SignUpRequest,
    signIn: SignInRequest,
  };

  provider = KernelContext.getStore().authenticationServiceProvider;

  async me() {
    const user = await Auth.user();

    if (!user) {
      throw new AuthorizationError();
    }

    return { user };
  }

  async signIn(req: SignInRequest) {
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
      throw new AuthenticationError();
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

    return { user };
  }

  async signUp(req: SignUpRequest) {
    const input = await req.input();
    const { email, password, name } = input.toJSON();

    const user = await this.provider.adapter.findUserByEmailAddress(email);

    if (user) {
      throw new Error("User already exists");
    }

    const hashedPassword = await this.provider.hashPassword(password);

    const newUser = await this.provider.adapter.createUser({
      email,
      name,
      password: hashedPassword,
    });

    await this.provider.onSignUp(newUser);

    return { user: newUser };
  }

  async signOut(req: HttpRequest) {
    const token = req.cookies.get("access_token");

    const user = await Auth.user();

    await this.provider.adapter.deleteSession({ token });

    req.ctx.setCookie("access_token", "", {
      expires: new Date(0),
    });

    await this.provider.onSignOut(user);

    return {};
  }

  async forgotPassword(req: HttpRequest) {
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

  async resetPassword(req: HttpRequest) {
    const input = await req.input();
    const { password, token } = input.toJSON();

    const passwordResetToken =
      await this.provider.adapter.findPasswordResetToken({ token });

    if (!passwordResetToken) {
      throw new Error("Invalid token");
    }

    const isTokenExpired = Temporal.Now.instant().until(
      Temporal.Instant.from(passwordResetToken.createdAt.toISOString())
        .add({ hours: 24 })
        .toString(),
    ).sign;

    if (isTokenExpired) {
      throw new Error("Token expired");
    }

    await this.provider.adapter.deletePasswordResetToken({ token });

    const user = await this.provider.adapter.findUserByEmailAddress(
      passwordResetToken.user.email,
    );

    if (!user) {
      throw new Error("User not found");
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
}

export class AuthApiRouter extends ApiRouter {
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
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
  routers = {
    api: AuthApiRouter,
    view: AuthViewRouter,
  };

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

  onSignUp<T extends User>(_user: T): Promise<void> | void {}
  onSignIn<T extends User>(_user: T): Promise<void> | void {}
  onSignOut<T extends User>(_user: T): Promise<void> | void {}
  onForgotPassword<T extends User>(
    _user: T,
    _verificationToken: string,
  ): Promise<void> | void {}
  onResetPassword<T extends User>(_user: T): Promise<void> | void {}
}
