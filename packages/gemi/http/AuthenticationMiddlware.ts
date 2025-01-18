import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";
import { RequestContext } from "./requestContext";
import { AuthenticationError } from "./errors";
import { AuthenticationServiceContainer } from "../auth/AuthenticationServiceContainer";

export class AuthenticationMiddleware extends Middleware {
  async run(_req: HttpRequest) {
    const requestContextStore = RequestContext.getStore();
    const accessTokenCookie =
      requestContextStore.req.cookies.get("access_token");
    const accessTokenHeader =
      requestContextStore.req.headers.get("access_token");

    const accessToken = accessTokenCookie || accessTokenHeader;

    if (!accessToken) {
      throw new AuthenticationError();
    }

    let user = requestContextStore.user;

    if (!user) {
      const session = await AuthenticationServiceContainer.use().getSession(
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
