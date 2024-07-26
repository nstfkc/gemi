import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { KernelContext } from "../kernel/KernelContext";

class AuthController extends Controller {
  async signIn(req: HttpRequest) {
    const input = await req.input();
    const { email } = input.toJSON();
    const kernelContext = KernelContext.getStore();
    const result =
      kernelContext.authenticationServiceProvider.getUserByEmailAddress(email);
    return { result };
  }
  async signUp(req: HttpRequest) {}
  async signOut(req: HttpRequest) {}
  async forgotPassword(req: HttpRequest) {}
  async resetPassword(req: HttpRequest) {}
  async refreshToken(req: HttpRequest) {}
}

class AuthApiRouter extends ApiRouter {
  routes = {
    "/sign-in": this.post(AuthController, "signIn"),
    "/sign-up": this.post(AuthController, "signUp"),
    "/sign-out": this.post(AuthController, "signOut"),
    "/forgot-password": this.post(AuthController, "forgotPassword"),
    "/reset-password": this.post(AuthController, "resetPassword"),
    "/refresh-token": this.post(AuthController, "refreshToken"),
  };
}

class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    // "/sign-up": this.view("auth/SignUp"),
    // "/reset-password": this.view("auth/ResetPassword"),
  };
}

export class AuthenticationServiceProvider {
  basePath = "/auth";
  routers = {
    api: AuthApiRouter,
    view: AuthViewRouter,
  };

  getUserByEmailAddress(email: string) {
    return { email };
  }
}
