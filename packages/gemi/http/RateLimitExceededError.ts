import type { RateLimitResult } from "../services/rate-limiter/types";
import { refusal, RequestBreakerError } from "./Error";

const DEFAULT_MESSAGE = "Rate limit exceeded";

/**
 * A 429 from the rate limiter: what the `rate-limit` middleware,
 * `RateLimiter.enforce` and the one-time-code limiter throw over budget.
 *
 * With the `result` that refused the request, the answer carries
 * `X-RateLimit-*` headers, `Retry-After` (seconds) and `retryAfter` (ms) in the
 * body's `error`, so a client can say when to try again without reading
 * headers:
 *
 * ```
 * 429 { error: { kind: "rate_limit", message, status: 429, retryAfter: 90000 } }
 * ```
 */
export class RateLimitExceededError extends RequestBreakerError {
  /** Milliseconds until a retry can succeed, when the result is known. */
  readonly retryAfter: number | undefined;

  constructor(
    readonly result?: RateLimitResult,
    message: string = DEFAULT_MESSAGE,
  ) {
    super(message);
    this.retryAfter = result?.retryAfter;
    const headers = {
      "Content-Type": "application/json",
      ...(result ? rateLimitHeaders(result) : {}),
    };

    this.payload = {
      api: {
        status: 429,
        data: {
          error: {
            ...refusal("rate_limit", message, 429),
            ...(result ? { retryAfter: result.retryAfter } : {}),
          },
        },
        headers,
      },
      view: {
        error: {
          message,
        },
        status: 429,
        headers,
      },
    };
  }
}

/** @internal */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };

  if (!result.allowed) {
    // Seconds, and never `0` — a `Retry-After: 0` invites an immediate retry
    // that is certain to be rejected again.
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil(result.retryAfter / 1000)),
    );
  }

  return headers;
}
