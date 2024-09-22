import type { User } from "../auth/adapters/types";
import { InsufficientPermissionsError } from "../http";
import { RequestContext } from "../http/requestContext";
import { KernelContext } from "../kernel/KernelContext";

export class Auth {
  static async user(): Promise<User | null> {
    const requestContextStore = RequestContext.getStore();
    const broadcastingContextStore =
      KernelContext.getStore().broadcastingServiceContainer.context.getStore();

    let accessToken = "";
    let userAgent = "";

    if (requestContextStore?.req) {
      accessToken = requestContextStore.req.cookies.get("access_token");
      userAgent = requestContextStore.req.headers.get("User-Agent");
    }

    if (broadcastingContextStore?.cookies) {
      userAgent = broadcastingContextStore.headers.get("User-Agent");
      accessToken = broadcastingContextStore.cookies.get("access_token");
    }

    let user = requestContextStore?.user;

    if (!user) {
      const container = KernelContext.getStore().authenticationServiceContainer;
      // TODO: extend session if its expired
      const session = await container.getSession(accessToken, userAgent);

      user = session?.user;
      requestContextStore?.setUser(user);
    }

    if (user) {
      return user;
    }

    return null;
  }

  static async guard(
    fn: (user: User) => Promise<boolean> | boolean,
  ): Promise<void> {
    const user = await Auth.user();

    if (!user) {
      throw new InsufficientPermissionsError();
    }

    try {
      if (!(await fn(user))) {
        throw new InsufficientPermissionsError();
      }
    } catch (err) {
      throw new InsufficientPermissionsError();
    }
  }

  static async guardSafe(
    fn: (user: User) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    const user = await Auth.user();

    if (!user) {
      return false;
    }
    try {
      return await fn(user);
    } catch (err) {
      return false;
    }
  }
}
