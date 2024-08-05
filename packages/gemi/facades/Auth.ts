import { RequestContext } from "../http/requestContext";
import { KernelContext } from "../kernel/KernelContext";

export class Auth {
  static async user() {
    const requestContextStore = RequestContext.getStore();
    const accessToken = requestContextStore.req.cookies.get("access_token");

    let user = requestContextStore.user;

    if (!user) {
      const session =
        await KernelContext.getStore().authenticationServiceProvider.adapter.findSession(
          {
            token: accessToken,
            userAgent: requestContextStore.req.headers.get("User-Agent"),
          },
        );
      user = session?.user;
      requestContextStore.setUser(user);
    }

    if (user) {
      return user;
    }

    return null;
  }
}
