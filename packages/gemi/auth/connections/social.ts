import { OAuthConnectionError } from "./errors";
import type { ProviderConnection } from "./ConnectionManager";
import type { OAuthConnectionProvider } from "./OAuthConnectionProvider";

/**
 * What every ready-made publishing connection provider (Facebook, LinkedIn,
 * TikTok, YouTube, X) says about the connected account: handed to
 * `onConnected` as `profile`, and read again with `provider.profile(connection)`.
 * Ids are always strings.
 */
export type ConnectedAccountProfile = {
  /** The platform's id for the account; also the connection's `providerAccountId`. */
  id: string;
  /** The display name, when the platform gives one. */
  name: string | null;
  /** The handle (`@name`), when the platform has one and gave it. */
  username: string | null;
  /** The profile picture, when the platform gave one. */
  avatarUrl: string | null;
};

/** The options every ready-made publishing connection provider takes. */
export interface SocialConnectionProviderConfig {
  /** The app's client id at the platform. Each provider documents its env default. */
  clientId?: string;
  /** The app's client secret at the platform. Each provider documents its env default. */
  clientSecret?: string;
  /** The scopes to request. Each provider documents its default. */
  scopes?: string[];
  /**
   * One user may connect several accounts at the platform, told apart by the
   * platform's account id. Default `false`. See `OAuthConnectionProviderConfig.multiple`.
   */
  multiple?: boolean;
  /** Extra authorization URL parameters. */
  authorizationParams?: Record<string, string>;
  /** Default `${HOST_NAME}/auth/connections/<name>/callback`. Register it with the platform. */
  redirectUri?: string;
  /** Refresh this many seconds before the access token expires. */
  refreshLeewaySeconds?: number;
  /** Override the platform's authorization endpoint (tests, proxies). */
  authorizeUrl?: string;
  /** Override the platform's token endpoint (tests, proxies). */
  tokenUrl?: string;
  /** Override the platform's API origin (tests, proxies). The token is only ever sent there. */
  apiBaseUrl?: string;
  /** Override (or, where the platform documents none, set) the revocation endpoint. */
  revokeUrl?: string;
}

/**
 * A JSON call made with a token the connection does not hold yet (during the
 * code exchange) or through `connection.fetch`. A failure is an
 * `OAuthConnectionError` with the HTTP status and never the body, which can
 * echo the token.
 */
export async function requestJson(
  what: string,
  failure: "exchange_failed" | "request_failed",
  send: () => Promise<Response>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await send();
  } catch (cause) {
    if (cause instanceof OAuthConnectionError) throw cause;
    throw new OAuthConnectionError(failure, `The ${what} request failed.`, { cause });
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || payload === null || typeof payload !== "object") {
    throw new OAuthConnectionError(failure, `The ${what} request was refused (HTTP ${response.status}).`, {
      // A 200 the body of which is not JSON is the platform misbehaving, not a refusal.
      status: response.ok ? 502 : response.status,
    });
  }
  return payload;
}

/** A bearer GET, for reading the account during the code exchange. */
export function bearerGet(url: string | URL, accessToken: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    headers: { ...headers, Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
  });
}

/** `connection` must belong to `provider`, for that provider's helpers. */
export function assertConnectionOf<T extends OAuthConnectionProvider>(
  connection: ProviderConnection,
  provider: T,
  helper: string,
): void {
  const actual = connection.connectionProvider();
  if (actual !== provider) {
    throw new TypeError(
      `${helper} takes a connection to this provider; "${connection.provider}" is configured with another one.`,
    );
  }
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** An id, which these platforms send as a string; a number (rounded past 2^53) is refused. */
export const idOrNull = stringOrNull;

export function missingAccountId(platform: string): OAuthConnectionError {
  return new OAuthConnectionError("exchange_failed", `${platform} did not say which account was connected.`, {
    status: 502,
  });
}
