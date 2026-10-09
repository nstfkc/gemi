/**
 * Why an OAuth connection operation failed. Never carries a token or a token
 * endpoint's body; `providerError` is the provider's RFC 6749 error code at
 * most (`invalid_grant`).
 */
export type OAuthConnectionErrorCode =
  | "unknown_provider"
  | "exchange_failed"
  | "refresh_failed"
  | "reconnect_required"
  | "revoke_failed"
  | "revoke_unsupported"
  | "forbidden_url"
  | "missing_account_id";

export class OAuthConnectionError extends Error {
  readonly status?: number;
  readonly providerError?: string;

  constructor(
    readonly code: OAuthConnectionErrorCode,
    message: string,
    options: { cause?: unknown; status?: number; providerError?: string } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OAuthConnectionError";
    this.status = options.status;
    this.providerError = options.providerError;
  }
}

/**
 * The connection's tokens no longer work and refreshing them failed, so the
 * user has to connect the account again (send them to
 * `/auth/connections/<provider>`). The connection is marked, so every later
 * call fails the same way without asking the provider again, until it is
 * reconnected.
 */
export class OAuthReconnectRequiredError extends OAuthConnectionError {
  constructor(
    readonly provider: string,
    options: { cause?: unknown; status?: number; providerError?: string } = {},
  ) {
    super(
      "reconnect_required",
      `The ${provider} connection needs to be reconnected: its tokens were refused and could not be refreshed.`,
      options,
    );
    this.name = "OAuthReconnectRequiredError";
  }
}
