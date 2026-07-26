import type { ConsumeParams, RateLimitResult } from "../types";

export abstract class RateLimiterDriver {
  /**
   * Records one request against `params.key` and reports whether it fits.
   *
   * Implementations must decide *and* record atomically — two concurrent calls
   * for the same key may never both be told they were the last one that fit.
   *
   * May be sync or async: the in-memory driver answers immediately, a network
   * backed driver returns a promise. Callers always `await` the result.
   */
  abstract consume(
    params: ConsumeParams,
  ): Promise<RateLimitResult> | RateLimitResult;
}
