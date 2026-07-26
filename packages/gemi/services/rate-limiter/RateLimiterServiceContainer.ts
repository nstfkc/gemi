import { ServiceContainer } from "../ServiceContainer";
import type { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";
import type { RateLimitResult } from "./types";

export interface ConsumeOptions {
  /** Requests allowed per window. Defaults to the provider's `limit`. */
  limit?: number;
  /** Window length in **seconds**. Defaults to the provider's `window`. */
  window?: number;
  /** How much this call costs. Defaults to `1`. */
  cost?: number;
}

export class RateLimiterServiceContainer extends ServiceContainer {
  static _name = "RateLimiterServiceContainer";

  constructor(public service: RateLimiterServiceProvider) {
    super();
  }

  /**
   * Records one hit against `key` and reports whether it fits the budget.
   *
   * Windows are given in seconds here — the unit routes, middleware and config
   * are written in — and converted to the milliseconds drivers work in.
   */
  async consume(
    key: string,
    options: ConsumeOptions = {},
  ): Promise<RateLimitResult> {
    const limit = options.limit ?? this.service.limit;
    const window = options.window ?? this.service.window;
    const cost = options.cost ?? 1;

    // A zero window divides by zero inside the sliding-window maths and a
    // negative cost hands out budget instead of spending it. Both mean the
    // caller passed something nonsensical, so say so rather than limiting in a
    // way nobody can explain later.
    assertPositive("window", window);
    assertPositive("limit", limit);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`Rate limiter cost must be zero or greater, got ${cost}`);
    }

    return await this.service.driver.consume({
      key,
      limit,
      window: window * 1000,
      cost,
    });
  }
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Rate limiter ${name} must be greater than zero, got ${value}`,
    );
  }
}
