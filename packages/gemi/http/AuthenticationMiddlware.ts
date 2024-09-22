import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";
import { KernelContext } from "../kernel/KernelContext";
import { AuthenticationError } from "./errors";

export class AuthenticationMiddleware extends Middleware {
  async run(req: HttpRequest) {
    const requestContextStore = RequestContext.getStore();
    const accessToken = requestContextStore.req.cookies.get("access_token");

    if (!accessToken) {
      throw new AuthenticationError();
    }

    let user = requestContextStore.user;

    if (!user) {
      const session =
        await KernelContext.getStore().authenticationServiceContainer.getSession(
          accessToken,
          requestContextStore.req.headers.get("User-Agent"),
        );
      if (!session) {
        throw new AuthenticationError();
      }
      user = session?.user;
      requestContextStore.setUser(user);
    }

    return {};
  }
}
