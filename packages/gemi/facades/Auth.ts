import { RequestContext } from "../http/requestContext";
import { KernelContext } from "../kernel/KernelContext";

export class Auth {
  static async user() {
    const requestContextStore = RequestContext.getStore();
    const accessToken = requestContextStore.req.cookies.get("access_token");

    const user =
      await KernelContext.getStore().authenticationServiceProvider.verifySession(
        accessToken,
      );

    if (user) {
      return user;
    }

    return null;
  }
}
