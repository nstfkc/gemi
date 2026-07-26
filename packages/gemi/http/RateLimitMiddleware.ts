import { app } from "../foundation/app";
import { RateLimiter } from "../services/rate-limiter/RateLimiter";
import type { RateLimitResult } from "../services/rate-limiter/types";
import { RequestBreakerError } from "./Error";
import type { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";

export class RateLimitExceededError extends RequestBreakerError {
  constructor(result?: RateLimitResult) {
    super("Rate limit exceeded");
    const headers = {
      "Content-Type": "application/json",
      ...(result ? rateLimitHeaders(result) : {}),
    };

    this.payload = {
      api: {
        status: 429,
        data: {
          error: {
            message: "Rate limit exceeded",
          },
        },
        headers,
      },
      view: {
        error: {
          message: "Rate limit exceeded",
        },
        status: 429,
        headers,
      },
    };
  }
}

export interface RateLimitMiddlewareConfig {
  /** Requests allowed per window. The DSL parameter wins over this. */
  limit?: number;
  /** Window length in **seconds**. The DSL parameter wins over this. */
  window?: number;
  /**
   * What counts as one client. Defaults to the caller's IP plus the route
   * path, so a client's budget for `/api/search` is separate from its budget
   * for `/api/upload`.
   *
   * Override it to limit by something more trustworthy than a header —
   * a session, an API key, a tenant:
   *
   * ```ts
   * RateLimitMiddleware.configure({
   *   limit: 60,
   *   key: (req) => `user:${req.ctx().user?.id ?? clientIp(req)}`,
   * })
   * ```
   */
  key?: (req: HttpRequest) => string;
  /** Set `X-RateLimit-*` response headers. Defaults to `true`. */
  headers?: boolean;
}

/**
 * Limits how often one client may hit a route.
 *
 * ```
 * "rate-limit"          // provider defaults (1000 per 60s)
 * "rate-limit:100"      // 100 per 60s
 * "rate-limit:10,30"    // 10 per 30s
 * ```
 *
 * The counting itself is the rate-limiter service's job, so the same DSL runs
 * against the in-memory driver locally and Redis in production.
 */
export class RateLimitMiddleware extends Middleware<RateLimitMiddlewareConfig> {
  async run(limit?: string | number, window?: string | number) {
    const limiter = resolveLimiter();

    // No application, or one without a rate limiter bound. Rejecting every
    // request because a service is missing would be a worse failure than not
    // limiting.
    if (!limiter) return {};

    const result = await limiter.consume(this.key(), {
      // The DSL passes strings (`"rate-limit:100,30"`), so both parameters are
      // parsed rather than trusted; anything unusable falls back to config and
      // then to the configured defaults.
      limit: toPositiveNumber(limit) ?? this.config.limit,
      window: toPositiveNumber(window) ?? this.config.window,
    });

    if (this.config.headers !== false) {
      const ctx = this.req.ctx?.();
      if (ctx) {
        for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
          ctx.setHeaders(name, value);
        }
      }
    }

    if (!result.allowed) {
      throw new RateLimitExceededError(result);
    }

    return {};
  }

  private key() {
    if (this.config.key) {
      return this.config.key(this.req);
    }
    return `${clientIp(this.req)}:${this.req.routePath ?? "*"}`;
  }
}

/**
 * The limiter, or `null` when there is nothing to resolve it from. `app()`
 * throws outside a booted application — unit tests, build-time tooling — and
 * that is not a reason to fail a request.
 */
function resolveLimiter(): RateLimiter | null {
  try {
    const container = app();
    return container.bound(RateLimiter) ? container.make(RateLimiter) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort client address.
 *
 * `x-forwarded-for` is a list — `client, proxy1, proxy2` — and the old
 * implementation used the whole string as the key, so a request arriving
 * through a different proxy chain got a fresh budget. Only the left-most entry
 * names the client.
 *
 * Both headers are trivially spoofed by anyone talking to the app directly, so
 * this is only sound behind a proxy that overwrites them. When you have
 * something better (a session, an API key), pass `key` in the config.
 */
export function clientIp(req: HttpRequest) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const [client] = forwardedFor.split(",");
    if (client?.trim()) return client.trim();
  }

  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
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

function toPositiveNumber(value: string | number | undefined) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}
