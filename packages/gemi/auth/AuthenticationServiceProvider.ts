import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { KernelContext } from "../kernel/KernelContext";
import { Auth } from "../facades";

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
  };

  provider = KernelContext.getStore().authenticationServiceProvider;

  async me() {
    const user = await Auth.user();

    if (!user) {
      throw new Error("Invalid token");
    }

    return { user };
  }

  async signIn(req: HttpRequest) {
    const input = await req.input();
    const { email, password } = input.toJSON();

    const user = await this.provider.findUserByEmailAddress(email);

    if (!user) {
      throw new Error("User not found");
    }

    const isPasswordValid = await this.provider.verifyPassword(user, password);

    if (!isPasswordValid) {
      throw new Error("Invalid credentials");
    }

    const session = await this.provider.createSession(user);

    req.ctx.setCookie("access_token", session.token, {
      expires: session.expiresAt,
    });

    // req.ctx.setCookie("refresh_token", session.refreshToken.token, {
    //   expires: session.refreshToken.expiresAt,
    // });

    // await this.provider.onSignIn(user);

    return {};
  }

  async signUp(req: SignUpRequest) {
    const kernelContext = KernelContext.getStore();
    const provider = kernelContext.authenticationServiceProvider;

    const input = await req.input();
    const { email, password, name } = input.toJSON();

    const user = await provider.findUserByEmailAddress(email);

    if (user) {
      throw new Error("User already exists");
    }

    const hashedPassword = await provider.hashPassword(password);

    const newUser = await provider.createUser({
      email,
      name,
      password: hashedPassword,
    });

    await provider.onSignUp(newUser);

    return { user: newUser };
  }

  async signOut(req: HttpRequest) {
    const access_token = req.cookies.get("access_token");

    await this.provider.deleteSession(access_token);
    req.ctx.setCookie("access_token", "", {
      expires: new Date(0),
    });

    req.ctx.setCookie("refresh_token", "", {
      expires: new Date(0),
    });

    await this.provider.onSignOut({ email: "email" });

    return {};
  }

  async forgotPassword(req: HttpRequest) {}
  async resetPassword(req: HttpRequest) {}
}

class AuthApiRouter extends ApiRouter {
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
    "/me": this.get(AuthController, "me"),
  };
}

class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    // "/sign-up": this.view("auth/SignUp"),
    // "/reset-password": this.view("auth/ResetPassword"),
  };
}

export interface User {
  email: string | null;
  password?: string | null;
  [key: string]: any;
}

export interface Session {
  token: string;
  expiresAt: Date;
  refreshToken?: {
    token: string;
    expiresAt: Date;
    [key: string]: any;
  };
}

export class AuthenticationServiceProvider {
  basePath = "/auth";
  routers = {
    api: AuthApiRouter,
    view: AuthViewRouter,
  };

  async findUserByEmailAddress(email: string): Promise<User | null> {
    return { email, password: "password" };
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    return await Bun.password.verify(password, user.password);
  }

  async hashPassword(password: string): Promise<string> {
    return await Bun.password.hash(password);
  }

  async createSession(_user: User): Promise<Session> {
    return { expiresAt: new Date(), token: "token" };
  }

  async deleteSession(_token: string): Promise<void> {}

  async createUser(user: User): Promise<User> {
    return user;
  }

  async verifySession(_token: string): Promise<User | null> {
    return { email: "email" };
  }

  async onSignUp(user: User) {}
  async onSignIn(user: User) {}
  async onSignOut(user: User) {}
  async onForgotPassword(user: User) {}
  async onResetPassword(user: User) {}
}
