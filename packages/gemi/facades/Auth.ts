import type { User } from "../auth/adapters/types";
import { RequestContext } from "../http/requestContext";
import { KernelContext } from "../kernel/KernelContext";

export class Auth {
  static async user(): Promise<User | null> {
    const requestContextStore = RequestContext.getStore();
    const accessToken = requestContextStore.req.cookies.get("access_token");

    let user = requestContextStore.user;

    if (!user) {
      const adapter =
        KernelContext.getStore().authenticationServiceProvider.adapter;
      // TODO: extend session if its expired
      const session = await adapter.findSession({
        token: accessToken,
        userAgent: requestContextStore.req.headers.get("User-Agent"),
      });

      user = session?.user;
      requestContextStore.setUser(user);
    }

    if (user) {
      return user;
    }

    return null;
  }
}
