import type { User } from "../auth/adapters/types";
import { AuthManager } from "../auth/AuthManager";
import {
  AuthenticationError,
  InsufficientPermissionsError,
} from "../http/errors";
import { RequestContext } from "../http/requestContext";
import { Broadcast } from "./Broadcast";
import { Facade } from "./Facade";

export class Auth extends Facade {
  static getFacadeAccessor() {
    return AuthManager;
  }

  static async user(): Promise<User> {
    const requestContextStore = RequestContext.getStore();
    const broadcastingContextStore =
      Broadcast.getFacadeRoot().context.getStore();

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
      const container = this.getFacadeRoot();
      // TODO: extend session if its expired
      const session = await container.getSession(accessToken, userAgent);

      user = session?.user;
      requestContextStore?.setUser(user);
    }

    if (user) {
      return user;
    }
    throw new AuthenticationError();
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

  static async authenticate(email: string) {
    const container = this.getFacadeRoot();
    return await container.authenticate(email);
  }

  static async createMagicLink(email: string) {
    const container = this.getFacadeRoot();
    return await container.createMagicLinkToken(email);
  }
}
