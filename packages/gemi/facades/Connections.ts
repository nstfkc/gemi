import type { OAuthTokenSet } from "../auth/connections/OAuthConnectionProvider";
import {
  type ConnectionOwner,
  ConnectionManager,
  type FakeConnectionHandler,
  type ProviderConnection,
} from "../auth/connections/ConnectionManager";
import { Facade } from "./Facade";

/**
 * The OAuth connections users have made to providers in `auth.connections`,
 * for calling those providers' APIs on their behalf:
 *
 * ```ts
 * const figma = await Connections.for(user, "figma"); // null when not connected
 * const res = await figma.fetch(`/v1/files/${key}`);  // bearer token, refresh, one retry on 401
 * await figma.revoke();
 * ```
 *
 * Send a user to `/auth/connections/figma` to connect.
 */
export class Connections extends Facade {
  static getFacadeAccessor() {
    return ConnectionManager;
  }

  /**
   * The user's connection to `provider`, or `null`. With `accountId`, only
   * the connection to that account (`providerAccountId`); for a provider with
   * `multiple: true` and no `accountId`, the account added most recently.
   */
  static for(user: ConnectionOwner, provider: string, accountId?: string): Promise<ProviderConnection | null> {
    return this.getFacadeRoot().for(user, provider, accountId);
  }

  /** Every connection the user has, or only those to `provider` (every account, with `multiple: true`). */
  static list(user: ConnectionOwner, provider?: string): Promise<ProviderConnection[]> {
    return this.getFacadeRoot().list(user, provider);
  }

  /**
   * Stores tokens for the user, replacing an earlier connection to the
   * provider (to the same `providerAccountId`, with `multiple: true`).
   */
  static save(
    user: ConnectionOwner,
    provider: string,
    tokens: Partial<OAuthTokenSet> & { accessToken: string },
  ): Promise<ProviderConnection> {
    return this.getFacadeRoot().save(user, provider, tokens);
  }

  /**
   * For tests: connections in memory, and each provider's API answered by
   * `handlers[provider]`. No token or revocation endpoint is called. Seed one
   * with `Connections.save(user, "figma", { accessToken: "test" })`; read what
   * was sent from `Connections.fake(...).fakeRequests`. Undo with `restore()`.
   */
  static fake(handlers: Record<string, FakeConnectionHandler> = {}): ConnectionManager {
    return this.getFacadeRoot().fake(handlers);
  }

  /** Undoes `fake`. */
  static restore(): void {
    this.getFacadeRoot().restore();
  }
}
