/**
 * A single request for capacity from the rate limiter.
 *
 * `key` identifies the bucket — everything the caller wants counted together.
 * The limiter never invents part of the key on its own, so callers stay in
 * control of what is limited (an IP, an IP plus a route, a user id, ...).
 */
export interface ConsumeParams {
  key: string;
  /** Maximum cost allowed inside one window. */
  limit: number;
  /** Window length in **milliseconds**. */
  window: number;
  /** How much this request costs. Defaults to `1`. */
  cost?: number;
}

export interface RateLimitResult {
  /** `false` means the caller is over budget and should be rejected. */
  allowed: boolean;
  /** The limit this decision was made against. */
  limit: number;
  /**
   * Capacity left in the window, floored to a whole request. `0` when the
   * request was denied.
   */
  remaining: number;
  /**
   * Epoch milliseconds. When allowed, the end of the current window — the
   * point where the oldest counted requests have fully decayed away. When
   * denied, the earliest moment a retry of the same cost can succeed.
   */
  resetAt: number;
  /** Milliseconds to wait before retrying. `0` when the request was allowed. */
  retryAfter: number;
}
