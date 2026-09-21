import type { User } from "../auth/types";
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
    // With no user this throws `AuthenticationError` (401, and a redirect to
    // sign-in for a view), before `fn` ever runs. Only a known user can be
    // refused with the 403 below.
    const user = await Auth.user();

    // An error thrown by `fn` propagates as itself. Turning it into a 403 would
    // report a database outage to the client as "you may not do this" and hide
    // it from `onRequestFail`; it still refuses the request either way.
    if (!(await fn(user))) {
      throw new InsufficientPermissionsError();
    }
  }

  static async guardSafe(
    fn: (user: User) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    // Like `guard`, this throws `AuthenticationError` with no user; `false`
    // means a known user the predicate refused.
    const user = await Auth.user();

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
