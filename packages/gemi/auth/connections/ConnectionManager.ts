import { DatabaseManager } from "../../database/DatabaseManager";
import { app } from "../../foundation/app";
import { currentEncrypter } from "../../orm/encryption";
import { LockManager } from "../../services/lock/LockManager";
import {
  type ConnectionRecord,
  type ConnectionStore,
  DatabaseConnectionStore,
  MemoryConnectionStore,
} from "./ConnectionStore";
import { OAuthConnectionError, OAuthReconnectRequiredError } from "./errors";
import { type OAuthConnectionProvider, type OAuthTokenSet, isLoopback } from "./OAuthConnectionProvider";

/** A user, as far as a connection is concerned: anything with an `id`. */
export type ConnectionOwner = { id: string | number } | string | number;

/** See `ProviderConnection.status`. */
export type ConnectionStatus = "connected" | "needs_reconnect";

/** What `Connections.fake` answers an API request with. */
export type FakeConnectionHandler = (request: Request) => Response | Promise<Response>;

export interface ConnectionManagerOptions {
  providers: Record<string, OAuthConnectionProvider>;
  /** Default: a `DatabaseConnectionStore` on the default database connection. */
  store?: ConnectionStore | (() => ConnectionStore);
}

/**
 * The OAuth connections a user has made, and the one place their tokens are
 * read, refreshed and spent. Reached through the `Connections` facade.
 */
export class ConnectionManager {
  static token = "auth.connections";

  private resolvedStore: ConnectionStore | undefined;
  private readonly refreshing = new Map<string, Promise<ConnectionRecord>>();
  private fakes: Map<string, FakeConnectionHandler> | undefined;
  private fakeStore: MemoryConnectionStore | undefined;
  readonly fakeRequests: Request[] = [];

  constructor(private readonly options: ConnectionManagerOptions) {
    for (const [name, provider] of Object.entries(options.providers)) {
      if (!provider.config.multiple) continue;
      // A multiple-account provider's connections are stored under
      // `<name>:<account id>`, which must not be read as another provider's.
      const clash = Object.keys(options.providers).find((other) => other.startsWith(`${name}${ACCOUNT_SEPARATOR}`));
      if (name.includes(ACCOUNT_SEPARATOR) || clash) {
        throw new Error(
          `auth.connections: "${clash ?? name}" cannot be used alongside the multiple-account provider "${name}" ` +
            `("${ACCOUNT_SEPARATOR}" separates a provider from an account id in the store).`,
        );
      }
    }
  }

  get providers(): Record<string, OAuthConnectionProvider> {
    return this.options.providers;
  }

  /** The store connections are kept in. */
  get store(): ConnectionStore {
    if (this.fakeStore) return this.fakeStore;
    if (!this.resolvedStore) {
      const configured = this.options.store;
      this.resolvedStore =
        typeof configured === "function"
          ? configured()
          : (configured ??
            new DatabaseConnectionStore(app(DatabaseManager).connection(), () => currentEncrypter()));
    }
    return this.resolvedStore;
  }

  provider(name: string): OAuthConnectionProvider {
    const provider = this.options.providers[name];
    if (!provider) {
      const known = Object.keys(this.options.providers);
      throw new OAuthConnectionError(
        "unknown_provider",
        `No OAuth connection provider "${name}" in auth.connections` +
          (known.length > 0 ? ` (configured: ${known.join(", ")}).` : " (none are configured)."),
      );
    }
    return provider;
  }

  /**
   * The user's connection to `provider`, or `null` when they have not
   * connected it. With `accountId`, only the connection to that account
   * (`providerAccountId`). For a provider with `multiple: true` and no
   * `accountId`, the account added most recently; use `list(user,
   * provider)` for all of them.
   */
  async for(user: ConnectionOwner, provider: string, accountId?: string): Promise<ProviderConnection | null> {
    const config = this.provider(provider);
    const userId = ownerId(user);
    if (!config.config.multiple) {
      const record = await this.store.find(userId, provider);
      if (!record || (accountId !== undefined && record.providerAccountId !== accountId)) return null;
      return new ProviderConnection(this, record);
    }
    if (accountId !== undefined) {
      const record =
        (await this.store.find(userId, storeKey(provider, accountId))) ??
        // Stored before the provider was switched to `multiple`.
        (await this.store.find(userId, provider));
      return record && record.providerAccountId === accountId ? new ProviderConnection(this, record) : null;
    }
    const [latest] = (await this.list(user, provider)).sort(
      (a, b) => b.connectedAt.getTime() - a.connectedAt.getTime(),
    );
    return latest ?? null;
  }

  /** Every connection the user has, or only those to `provider`. */
  async list(user: ConnectionOwner, provider?: string): Promise<ProviderConnection[]> {
    if (provider !== undefined) this.provider(provider);
    const records = await this.store.list(ownerId(user));
    return records
      .filter((record) => {
        const name = this.providerName(record.provider);
        return name !== null && (provider === undefined || name === provider);
      })
      .map((record) => new ProviderConnection(this, record));
  }

  /**
   * Stores tokens for the user, replacing any earlier connection to the same
   * provider — or, for a provider with `multiple: true`, to the same account
   * (`providerAccountId`, required there). The connect callback calls this;
   * call it yourself for tokens obtained some other way.
   */
  async save(
    user: ConnectionOwner,
    provider: string,
    tokens: Partial<OAuthTokenSet> & { accessToken: string },
  ): Promise<ProviderConnection> {
    const config = this.provider(provider);
    const userId = ownerId(user);
    const { profile: _profile, ...grant } = tokens;
    const set: OAuthTokenSet = {
      refreshToken: null,
      tokenType: null,
      expiresAt: null,
      providerAccountId: null,
      scopes: config.config.scopes,
      ...grant,
    };
    if (!config.config.multiple) {
      return new ProviderConnection(this, await this.store.save(userId, provider, set));
    }

    const accountId = set.providerAccountId;
    if (typeof accountId !== "string" || accountId === "") {
      throw new OAuthConnectionError(
        "missing_account_id",
        `"${provider}" allows several accounts per user, so a connection needs the provider's account id ` +
          "(providerAccountId), and the token exchange did not supply one.",
      );
    }
    const record = await this.store.save(userId, storeKey(provider, accountId), set);
    // The same account, stored before the provider was switched to `multiple`.
    const legacy = await this.store.find(userId, provider);
    if (legacy && legacy.providerAccountId === accountId) await this.store.delete(legacy.id);
    return new ProviderConnection(this, record);
  }

  /**
   * The configured provider a stored connection belongs to: the store key
   * itself, or `<name>` of a multiple-account provider's `<name>:<account id>`.
   * `null` for a provider no longer configured.
   *
   * @internal
   */
  providerName(key: string): string | null {
    const providers = this.options.providers;
    if (Object.hasOwn(providers, key)) return key;
    const at = key.indexOf(ACCOUNT_SEPARATOR);
    if (at <= 0) return null;
    const name = key.slice(0, at);
    return Object.hasOwn(providers, name) && providers[name].config.multiple ? name : null;
  }

  // --- testing ---------------------------------------------------------------

  /**
   * Fakes every provider's API: connections live in memory, `fetch` answers
   * through `handlers[provider]` (recorded in `fakeRequests`), and nothing
   * reaches a token or revocation endpoint. Returns `this` so a test can
   * `save` a connection to start from.
   */
  fake(handlers: Record<string, FakeConnectionHandler> = {}): this {
    this.fakes = new Map(Object.entries(handlers));
    this.fakeStore = new MemoryConnectionStore();
    this.fakeRequests.length = 0;
    return this;
  }

  /** Undoes `fake`. */
  restore(): void {
    this.fakes = undefined;
    this.fakeStore = undefined;
    this.fakeRequests.length = 0;
  }

  get faked(): boolean {
    return this.fakes !== undefined;
  }

  // --- internals, for ProviderConnection ---------------------------------------

  /** @internal */
  async send(provider: string, request: Request): Promise<Response> {
    if (!this.fakes) return fetch(request);
    this.fakeRequests.push(request.clone());
    const handler = this.fakes.get(provider);
    if (!handler) {
      throw new Error(`Connections.fake() has no handler for "${provider}". Pass one: Connections.fake({ ${provider}: (req) => ... }).`);
    }
    return handler(request);
  }

  /**
   * A record whose access token is not the one at `staleRevision`: refreshed
   * by this call, or by whoever refreshed it first. Serialised per connection
   * in this process (concurrent callers share one refresh) and, through the
   * app's lock store, across processes — a rotating refresh token must be
   * spent exactly once.
   *
   * @internal
   */
  refresh(record: ConnectionRecord): Promise<ConnectionRecord> {
    const inFlight = this.refreshing.get(record.id);
    if (inFlight) return inFlight;
    const task = this.withLock(record.id, () => this.refreshOnce(record)).finally(() =>
      this.refreshing.delete(record.id),
    );
    this.refreshing.set(record.id, task);
    return task;
  }

  private async refreshOnce(seen: ConnectionRecord): Promise<ConnectionRecord> {
    // Re-read under the lock: another process may have refreshed already.
    const name = this.providerName(seen.provider) ?? seen.provider;
    const current = await this.store.find(seen.userId, seen.provider);
    if (!current || current.id !== seen.id) {
      throw new OAuthReconnectRequiredError(name);
    }
    if (current.revision !== seen.revision && !current.needsReconnect) return current;
    if (current.needsReconnect) throw new OAuthReconnectRequiredError(name);

    const provider = this.provider(name);
    if (this.faked) return current;
    const strategy = provider.config.refreshStrategy;
    if (!strategy && current.refreshToken === null) {
      await this.store.markNeedsReconnect(current.id);
      throw new OAuthReconnectRequiredError(name);
    }

    let tokens: OAuthTokenSet | null;
    try {
      tokens = strategy
        ? await strategy({
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            scopes: [...current.scopes],
            expiresAt: current.expiresAt,
            issuedAt: current.updatedAt,
            providerAccountId: current.providerAccountId,
          })
        : await provider.refresh(current.refreshToken as string, current.scopes);
    } catch (error) {
      // A refusal from the token endpoint is final: the grant is gone. A
      // network error or a 5xx is not, and leaves the connection alone. Nor
      // is `invalid_client`: the app's own credentials (or `clientAuth`) are
      // wrong, reconnecting would fail the same way, and marking would make
      // every user reconnect once the config is fixed.
      if (
        error instanceof OAuthConnectionError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.providerError !== "invalid_client"
      ) {
        await this.store.markNeedsReconnect(current.id);
        throw new OAuthReconnectRequiredError(name, {
          cause: error,
          status: error.status,
          providerError: error.providerError,
        });
      }
      throw error;
    }
    // The strategy has nothing to refresh yet: keep the current token.
    if (tokens === null) return current;

    const updated = await this.store.updateTokens(current.id, current.revision, tokens);
    if (updated) return updated;
    // Someone else wrote first (only possible without a shared lock store).
    const winner = await this.store.find(current.userId, current.provider);
    if (!winner) throw new OAuthReconnectRequiredError(name);
    return winner;
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const application = app();
    if (this.faked || !application.bound(LockManager)) return fn();
    const result = await application
      .make(LockManager)
      .run(`gemi:oauth-connection:${id}`, { ttl: 30_000, wait: 20_000 }, () => fn());
    if (!result.acquired) {
      throw new OAuthConnectionError(
        "refresh_failed",
        "Timed out waiting for another refresh of this connection to finish.",
      );
    }
    return result.value as T;
  }
}

/**
 * One user's connection to one provider. Never exposes a token as a property,
 * and serialises (`toJSON`, `console.log`) without them.
 */
export class ProviderConnection {
  constructor(
    private readonly manager: ConnectionManager,
    private record: ConnectionRecord,
  ) {}

  /** The provider's name under `auth.connections`. */
  get provider(): string {
    return this.manager.providerName(this.record.provider) ?? this.record.provider;
  }
  get userId(): string {
    return this.record.userId;
  }
  get providerAccountId(): string | null {
    return this.record.providerAccountId;
  }
  /** The scopes the provider granted. */
  get scopes(): readonly string[] {
    return this.record.scopes;
  }
  get expiresAt(): Date | null {
    return this.record.expiresAt;
  }
  /** A refresh was refused: the user has to connect again. */
  get needsReconnect(): boolean {
    return this.record.needsReconnect;
  }
  get connectedAt(): Date {
    return this.record.createdAt;
  }

  /**
   * What to show the user: `"needs_reconnect"` when a refresh was refused, or
   * when the access token has expired and there is no refresh token to renew
   * it; `"connected"` otherwise. Read without calling the provider.
   */
  get status(): ConnectionStatus {
    if (this.record.needsReconnect) return "needs_reconnect";
    const expiresAt = this.record.expiresAt?.getTime();
    if (this.record.refreshToken === null && expiresAt !== undefined && expiresAt <= Date.now()) {
      return "needs_reconnect";
    }
    return "connected";
  }

  /** Whether every one of `scopes` was granted. */
  hasScopes(...scopes: string[]): boolean {
    return scopes.every((scope) => this.record.scopes.includes(scope));
  }

  /**
   * `fetch`, as the user: adds `Authorization: Bearer <token>`, refreshes the
   * token first when it is about to expire, and after a 401 refreshes and
   * retries once. A refresh the provider refuses marks the connection and
   * throws `OAuthReconnectRequiredError`.
   *
   * A path is resolved against the provider's `apiBaseUrl`, and a URL on any
   * other origin is refused (`OAuthConnectionError`,
   * `forbidden_url`), so the token only ever goes to the provider. Redirects
   * are followed by hand: the token is dropped on one that leaves the origin.
   * A streamed request body cannot be sent twice, so a 401 for one is
   * returned rather than retried.
   */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = this.resolveUrl(input);
    const record = await this.current();
    const first = await this.send(url, init, record.accessToken);
    // Retry only a 401 for the token itself, not one from where a redirect
    // led after the token was dropped.
    if (first.response.status !== 401 || !first.authorized || init.body instanceof ReadableStream) {
      return first.response;
    }

    await first.response.body?.cancel().catch(() => {});
    const refreshed = await this.refreshFrom(record);
    return (await this.send(url, init, refreshed.accessToken)).response;
  }

  /**
   * A valid access token, refreshed first if it is about to expire — for an
   * SDK that wants the token itself. Prefer `fetch`, which also retries a 401.
   */
  async accessToken(): Promise<string> {
    return (await this.current()).accessToken;
  }

  /** Refreshes now, whatever the expiry says. */
  async refresh(): Promise<void> {
    await this.refreshFrom(this.record);
  }

  /**
   * Revokes the grant at the provider (the refresh token when there is one,
   * which ends the whole grant, else the access token) and deletes the
   * connection. If the provider refuses, nothing is deleted and
   * `OAuthConnectionError` (`revoke_failed`) is thrown — call `disconnect()`
   * to forget the tokens anyway. A provider without a `revokeUrl` throws
   * `revoke_unsupported`; use `disconnect()`.
   */
  async revoke(): Promise<void> {
    if (!this.manager.faked) {
      const provider = this.manager.provider(this.provider);
      if (this.record.refreshToken !== null) {
        await provider.revoke(this.record.refreshToken, "refresh_token");
      } else {
        await provider.revoke(this.record.accessToken, "access_token");
      }
    }
    await this.manager.store.delete(this.record.id);
  }

  /** Forgets the tokens locally without telling the provider. */
  async disconnect(): Promise<void> {
    await this.manager.store.delete(this.record.id);
  }

  toJSON() {
    return {
      provider: this.provider,
      providerAccountId: this.providerAccountId,
      scopes: [...this.scopes],
      expiresAt: this.expiresAt,
      needsReconnect: this.needsReconnect,
      status: this.status,
      connectedAt: this.connectedAt,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return { ProviderConnection: this.toJSON() };
  }

  private async current(): Promise<ConnectionRecord> {
    if (this.record.needsReconnect) throw new OAuthReconnectRequiredError(this.provider);
    const leeway = this.manager.provider(this.provider).config.refreshLeewaySeconds * 1000;
    const expiresAt = this.record.expiresAt?.getTime();
    if (expiresAt !== undefined && expiresAt - Date.now() <= leeway) {
      return this.refreshFrom(this.record);
    }
    return this.record;
  }

  private async refreshFrom(record: ConnectionRecord): Promise<ConnectionRecord> {
    try {
      this.record = await this.manager.refresh(record);
    } catch (error) {
      if (error instanceof OAuthReconnectRequiredError) {
        this.record = { ...this.record, needsReconnect: true };
      }
      throw error;
    }
    return this.record;
  }

  private resolveUrl(input: string | URL): URL {
    const base = this.manager.provider(this.provider).config.apiBaseUrl;
    let url: URL;
    try {
      url = new URL(String(input), base);
    } catch {
      throw new OAuthConnectionError(
        "forbidden_url",
        `connection.fetch was given ${JSON.stringify(String(input))}, which is not a URL.`,
      );
    }
    if (url.origin !== new URL(base).origin) {
      throw new OAuthConnectionError(
        "forbidden_url",
        `connection.fetch only sends the ${this.provider} token to ${new URL(base).origin} ` +
          `(apiBaseUrl), not to ${url.origin}.`,
      );
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new OAuthConnectionError(
        "forbidden_url",
        `connection.fetch only sends a token over https, not to ${url.origin}.`,
      );
    }
    return url;
  }

  private async send(url: URL, init: RequestInit, token: string): Promise<{ response: Response; authorized: boolean }> {
    let target = url;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let authorized = true;

    // Followed by hand (unless the caller asked for "manual" or "error"), so
    // the token never follows a redirect to another origin.
    if (init.redirect === "manual" || init.redirect === "error") {
      const response = await this.manager.send(this.provider, this.request(target, init, method, body, token));
      return { response, authorized };
    }

    for (let hop = 0; ; hop++) {
      const request = this.request(target, { ...init, redirect: "manual" }, method, body, authorized ? token : null);
      const response = await this.manager.send(this.provider, request);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || location === null || hop >= 5) return { response, authorized };

      await response.body?.cancel().catch(() => {});
      const next = new URL(location, target);
      if (next.origin !== target.origin) authorized = false;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      target = next;
    }
  }

  private request(url: URL, init: RequestInit, method: string, body: RequestInit["body"], token: string | null): Request {
    const headers = new Headers(init.headers);
    if (token === null) headers.delete("authorization");
    else headers.set("Authorization", `Bearer ${token}`);
    return new Request(url, { ...init, method, body, headers });
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Between a multiple-account provider's name and the account id, in the store's `provider` column. */
const ACCOUNT_SEPARATOR = ":";

function storeKey(provider: string, accountId: string): string {
  return `${provider}${ACCOUNT_SEPARATOR}${accountId}`;
}

function ownerId(user: ConnectionOwner): string {
  const id = typeof user === "object" && user !== null ? user.id : user;
  if (id === undefined || id === null || id === "") {
    throw new TypeError("An OAuth connection belongs to a user: pass the user (or its id).");
  }
  return String(id);
}
