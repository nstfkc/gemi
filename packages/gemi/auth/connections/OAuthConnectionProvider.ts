import { OAuthConnectionError } from "./errors";

export interface OAuthConnectionProviderConfig {
  /** The provider's authorization endpoint: `https://www.figma.com/oauth`. */
  authorizeUrl: string;
  /** The token endpoint, for the code exchange (and refreshes, unless `refreshUrl` says otherwise). */
  tokenUrl: string;
  /**
   * Where refresh tokens are spent, for a provider with a refresh endpoint of
   * its own: Figma refreshes at `https://api.figma.com/v1/oauth/refresh`.
   * Default `tokenUrl`.
   */
  refreshUrl?: string;
  /**
   * The `grant_type` sent with a refresh. Default `"refresh_token"` (RFC 6749
   * §6). `false` leaves it out, for a refresh endpoint that documents only
   * `refresh_token` (Figma's).
   */
  refreshGrantType?: string | false;
  /**
   * The RFC 7009 revocation endpoint. Without one, `revoke()` is refused and
   * `disconnect()` (which forgets the tokens locally) is the way to remove a
   * connection.
   */
  revokeUrl?: string;
  clientId: string;
  clientSecret: string;
  /** The scopes to request. */
  scopes: string[];
  /** How `scopes` are joined on the authorization URL. Default `" "` (RFC 6749). */
  scopeSeparator?: string;
  /**
   * How the client authenticates to the token, refresh and revocation endpoints:
   * `"body"` sends `client_id` and `client_secret` as form fields (what most
   * providers document), `"basic"` sends them as HTTP Basic credentials.
   * Default `"body"`.
   */
  clientAuth?: "body" | "basic";
  /** Send a PKCE challenge (S256). Default `true`; turn off only for a provider that rejects it. */
  pkce?: boolean;
  /**
   * Extra query parameters for the authorization URL, such as
   * `{ access_type: "offline", prompt: "consent" }` for Google. They cannot
   * replace `state`, the PKCE challenge, `redirect_uri`, `client_id` or `scope`.
   */
  authorizationParams?: Record<string, string>;
  /**
   * The callback URL registered with the provider. Default
   * `${HOST_NAME}/auth/connections/<name>/callback` (the request's origin when
   * `HOST_NAME` is unset).
   */
  redirectUri?: string;
  /**
   * Where the provider's API lives: `https://api.figma.com`. Required:
   * `connection.fetch` takes paths relative to it and **refuses any other
   * origin**, so the user's token only ever goes to the provider's API host,
   * even for a URL that came from user input.
   */
  apiBaseUrl: string;
  /** Refresh this many seconds before the access token expires. Default 60. */
  refreshLeewaySeconds?: number;
  /**
   * How a connection is refreshed, for a provider that does not spend a
   * refresh token at a token endpoint. Instagram, for one, renews the
   * long-lived access token itself (`ig_refresh_token`) and issues no refresh
   * token. Unset, a refresh spends the refresh token at `refreshUrl`, and a
   * connection without one has to be reconnected once its token expires.
   *
   * Resolve the new tokens, or `null` when there is nothing to refresh yet
   * (the current token is kept, and nothing is marked). Throw
   * `OAuthConnectionError` with the HTTP `status` for a refusal: a 4xx (other
   * than `invalid_client`) marks the connection `needs_reconnect`, anything
   * else leaves it alone.
   */
  refreshStrategy?: ConnectionRefreshStrategy;
  /**
   * Lets a user connect more than one account at this provider (several
   * Instagram accounts to post to). Connections are then told apart by
   * `providerAccountId`, which the exchange must supply; connecting an
   * account again replaces only that account's connection. Default `false`:
   * one connection per user, and connecting again replaces it.
   */
  multiple?: boolean;
  /**
   * How `connection.fetch` sends the token: `"header"` (the default) as
   * `Authorization: Bearer`, `"query"` as an `access_token` query parameter,
   * for an API that documents only that (Instagram's Graph API). Either way
   * the token goes only to `apiBaseUrl`'s origin.
   */
  tokenPlacement?: "header" | "query";
  /**
   * Whether an API response says the access token itself was refused, which
   * makes `connection.fetch` refresh and retry once. Default: the status is
   * 401. Instagram also answers a dead token with a 400 whose error `code` is
   * 190. Read `response.clone()`, never the response itself: it is handed
   * back to the caller when this answers `false`. Clone only once the status
   * says it could be a refusal, so a large success body is not buffered twice.
   */
  isTokenRejected?: (response: Response) => boolean | Promise<boolean>;
}

/**
 * Why a connection is being refreshed: its token is about to expire, the API
 * refused it, or the app called `connection.refresh()`.
 */
export type ConnectionRefreshReason = "expiring" | "rejected" | "requested";

/** What a `refreshStrategy` is handed: the connection's current grant. */
export interface ConnectionRefreshContext {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: Date | null;
  /** When the current access token was stored (the last connect or refresh). */
  issuedAt: Date;
  providerAccountId: string | null;
  /**
   * Why: `"rejected"` when the API just refused the token, so a strategy that
   * would otherwise wait (`null`) should treat the grant as gone.
   */
  reason: ConnectionRefreshReason;
}

/** See `OAuthConnectionProviderConfig.refreshStrategy`. */
export type ConnectionRefreshStrategy = (
  context: ConnectionRefreshContext,
) => Promise<OAuthTokenSet | null>;

/** What a token endpoint answered, normalised. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  /** Absent when the provider did not say (`expires_in` missing). */
  expiresAt: Date | null;
  /** The scopes granted, when the provider says; otherwise the ones requested. */
  scopes: string[];
  /**
   * The provider's id for the account, when the token response carries one
   * (Figma's `user_id_string`; `user_id` or `account_id` otherwise).
   */
  providerAccountId: string | null;
  /**
   * What the provider said about the account at connect time (Instagram's
   * username and picture, say), handed to `onConnected` and not stored.
   */
  profile?: Record<string, unknown>;
}

/**
 * A provider an app can connect a user's account to, to call its API on the
 * user's behalf — as opposed to `OAuthProvider`, which signs the user in.
 * Configured under `auth.connections`:
 *
 * ```ts
 * connections: {
 *   figma: new OAuthConnectionProvider({
 *     authorizeUrl: "https://www.figma.com/oauth",
 *     tokenUrl: "https://api.figma.com/v1/oauth/token",
 *     refreshUrl: "https://api.figma.com/v1/oauth/refresh",
 *     refreshGrantType: false,
 *     clientAuth: "basic",
 *     clientId: process.env.FIGMA_CLIENT_ID!,
 *     clientSecret: process.env.FIGMA_CLIENT_SECRET!,
 *     scopes: ["file_content:read"],
 *     apiBaseUrl: "https://api.figma.com",
 *   }),
 * }
 * ```
 */
export class OAuthConnectionProvider {
  readonly config: Required<
    Omit<OAuthConnectionProviderConfig, "revokeUrl" | "redirectUri" | "refreshUrl" | "refreshStrategy" | "isTokenRejected">
  > &
    Pick<
      OAuthConnectionProviderConfig,
      "revokeUrl" | "redirectUri" | "refreshUrl" | "refreshStrategy" | "isTokenRejected"
    >;

  constructor(config: OAuthConnectionProviderConfig) {
    for (const key of ["authorizeUrl", "tokenUrl"] as const) {
      assertHttpUrl(key, config[key]);
    }
    for (const key of ["refreshUrl", "revokeUrl"] as const) {
      if (config[key] !== undefined) assertHttpUrl(key, config[key]);
    }
    // Required (not just recommended): it is what keeps `connection.fetch`
    // from sending the user's token anywhere but the provider's API host. A
    // missing one (`process.env.X` unset, or plain JS) fails the boot, when
    // the auth config is loaded, rather than the first `fetch`.
    if (config.apiBaseUrl === undefined || config.apiBaseUrl === null || config.apiBaseUrl === "") {
      throw new Error(
        "OAuthConnectionProvider: apiBaseUrl is required. Set it to the provider's API origin " +
          '(e.g. apiBaseUrl: "https://api.figma.com"); connection.fetch only sends the token there.',
      );
    }
    assertHttpUrl("apiBaseUrl", config.apiBaseUrl);
    this.config = {
      scopeSeparator: " ",
      clientAuth: "body",
      pkce: true,
      authorizationParams: {},
      refreshLeewaySeconds: 60,
      multiple: false,
      tokenPlacement: "header",
      ...config,
      refreshGrantType: config.refreshGrantType ?? "refresh_token",
    };
  }

  /**
   * Whether `response` refuses the access token itself: `isTokenRejected`
   * when configured, else a 401.
   */
  async isTokenRejected(response: Response): Promise<boolean> {
    const check = this.config.isTokenRejected;
    if (!check) return response.status === 401;
    return await check(response);
  }

  /** The URL to send the browser to. */
  authorizationUrl(args: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.config.authorizeUrl);
    const params: Record<string, string> = {
      ...this.config.authorizationParams,
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: args.redirectUri,
      scope: this.config.scopes.join(this.config.scopeSeparator),
      state: args.state,
    };
    if (this.config.pkce) {
      params.code_challenge = args.codeChallenge;
      params.code_challenge_method = "S256";
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Exchanges an authorization code for tokens. */
  exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    });
    if (this.config.pkce) body.set("code_verifier", args.codeVerifier);
    return this.tokenRequest(this.config.tokenUrl, body, {
      scopes: this.config.scopes,
      refreshToken: null,
      phase: "exchange",
    });
  }

  /**
   * Spends `refreshToken` for a new access token at `refreshUrl` (default
   * `tokenUrl`). A provider that does not rotate refresh tokens (Figma)
   * answers without one, and the old one is kept.
   */
  refresh(refreshToken: string, scopes: string[]): Promise<OAuthTokenSet> {
    const body = new URLSearchParams();
    const grantType = this.config.refreshGrantType;
    if (grantType !== false && grantType !== "") body.set("grant_type", grantType);
    body.set("refresh_token", refreshToken);
    return this.tokenRequest(this.config.refreshUrl ?? this.config.tokenUrl, body, {
      scopes,
      refreshToken,
      phase: "refresh",
    });
  }

  /** Revokes `token` at the provider (RFC 7009). */
  async revoke(token: string, hint: "refresh_token" | "access_token"): Promise<void> {
    if (!this.config.revokeUrl) {
      throw new OAuthConnectionError(
        "revoke_unsupported",
        "This provider has no revokeUrl configured. Use disconnect() to forget the tokens locally.",
      );
    }
    const body = new URLSearchParams({ token, token_type_hint: hint });
    let response: Response;
    try {
      response = await fetch(this.config.revokeUrl, this.post(body));
    } catch (cause) {
      throw new OAuthConnectionError("revoke_failed", "The revocation request failed.", { cause });
    }
    // RFC 7009: 200 whether or not the token was still valid.
    if (!response.ok) {
      throw new OAuthConnectionError(
        "revoke_failed",
        `The provider refused the revocation (HTTP ${response.status}).`,
        { status: response.status },
      );
    }
  }

  private post(body: URLSearchParams): RequestInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      // GitHub answers form-encoded unless asked for JSON.
      Accept: "application/json",
    };
    if (this.config.clientAuth === "basic") {
      const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    } else {
      body.set("client_id", this.config.clientId);
      body.set("client_secret", this.config.clientSecret);
    }
    return { method: "POST", headers, body: body.toString(), redirect: "error" };
  }

  private async tokenRequest(
    endpoint: string,
    body: URLSearchParams,
    previous: { scopes: string[]; refreshToken: string | null; phase: "exchange" | "refresh" },
  ): Promise<OAuthTokenSet> {
    const failure = previous.phase === "exchange" ? "exchange_failed" : "refresh_failed";
    let response: Response;
    try {
      response = await fetch(endpoint, this.post(body));
    } catch (cause) {
      throw new OAuthConnectionError(failure, "The token request failed.", { cause });
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== "string" || payload.access_token === "") {
      // Only the provider's error code, never the body: it can echo the grant.
      const code = typeof payload.error === "string" && /^[a-z0-9_]{1,64}$/.test(payload.error) ? payload.error : undefined;
      throw new OAuthConnectionError(
        failure,
        `The token endpoint refused the ${previous.phase === "exchange" ? "code" : "refresh token"} ` +
          `(HTTP ${response.status}${code ? `, ${code}` : ""}).`,
        { status: response.status, providerError: code },
      );
    }

    const expiresIn = Number(payload.expires_in);
    const scope = typeof payload.scope === "string" ? payload.scope : undefined;
    // Figma's `user_id_string` before its deprecated numeric `user_id`, which
    // JSON parsing has already rounded: Figma's ids do not fit a double.
    const accountId = payload.user_id_string ?? payload.user_id ?? payload.account_id;
    return {
      accessToken: payload.access_token,
      refreshToken:
        typeof payload.refresh_token === "string" && payload.refresh_token !== ""
          ? payload.refresh_token
          : previous.refreshToken,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
      scopes: scope !== undefined ? scope.split(/[\s,]+/).filter(Boolean) : previous.scopes,
      providerAccountId:
        typeof accountId === "string" || typeof accountId === "number" ? String(accountId) : null,
    };
  }
}

function assertHttpUrl(key: string, value: unknown): void {
  let url: URL | undefined;
  try {
    url = new URL(String(value));
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) {
    throw new Error(
      `OAuthConnectionProvider: ${key} must be an https URL (http only for localhost), got ${JSON.stringify(value)}.`,
    );
  }
}

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
