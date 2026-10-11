import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isRateLimitError, mutationErrorFromBody } from "../../client/MutationError";
import { RateLimiter as RateLimiterFacade } from "../../facades/RateLimiter";
import { Application } from "../../foundation/Application";
import { RateLimitExceededError } from "../../http/RateLimitMiddleware";
import { kernelContext } from "../../kernel/context";
import { Repository } from "../../support/Repository";
import { RateLimiter } from "./RateLimiter";
import { RateLimiterServiceProvider } from "./RateLimiterServiceProvider";

// Issue #882: `enforce` consumes, and refuses with the middleware's 429.

function makeApp() {
  const application = new Application(new Repository({ ratelimiter: {} }));
  application.register(RateLimiterServiceProvider);
  return application;
}

const rule = { limit: 2, window: 3600 };

async function thrown(run: () => Promise<unknown>): Promise<RateLimitExceededError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RateLimitExceededError) return error;
    throw error;
  }
  throw new Error("expected enforce to throw");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter.enforce", () => {
  test("returns the result within budget, and throws a 429 carrying the message over it", async () => {
    await kernelContext.run(makeApp(), async () => {
      const first = await RateLimiterFacade.enforce("publish:1", rule, "Slow down");
      expect(first).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
      await RateLimiterFacade.enforce("publish:1", rule, "Slow down");

      const error = await thrown(() => RateLimiterFacade.enforce("publish:1", rule, "Slow down"));

      expect(error.message).toBe("Slow down");
      expect(error.result?.allowed).toBe(false);
      expect(error.retryAfter).toBeGreaterThan(0);
      expect(error.payload.api.status).toBe(429);
      expect(error.payload.api.data.error).toEqual({
        kind: "rate_limit",
        message: "Slow down",
        status: 429,
        retryAfter: error.retryAfter,
      });
      expect(error.payload.api.headers).toMatchObject({
        "Retry-After": String(Math.ceil(error.retryAfter! / 1000)),
        "X-RateLimit-Limit": "2",
        "X-RateLimit-Remaining": "0",
      });
      expect(error.payload.view).toMatchObject({ status: 429, error: { message: "Slow down" } });
    });
  });

  test("keys are separate budgets", async () => {
    await kernelContext.run(makeApp(), async () => {
      const one = { limit: 1, window: 60 };
      await RateLimiterFacade.enforce("a", one);
      await expect(RateLimiterFacade.enforce("b", one)).resolves.toMatchObject({ allowed: true });
      await expect(RateLimiterFacade.enforce("a", one)).rejects.toBeInstanceOf(RateLimitExceededError);
    });
  });

  test("a message function is built from the refusing result", async () => {
    await kernelContext.run(makeApp(), async () => {
      const message = vi.fn(
        ({ retryAfter }: { retryAfter: number }) =>
          `Try again in ${Math.ceil(retryAfter / 60_000)} minutes.`,
      );
      const one = { limit: 1, window: 600 };
      await RateLimiterFacade.enforce("k", one, message);
      expect(message).not.toHaveBeenCalled();

      const error = await thrown(() => RateLimiterFacade.enforce("k", one, message));

      expect(message).toHaveBeenCalledOnce();
      expect(message.mock.calls[0]![0]).toBe(error.result);
      expect(error.message).toBe(`Try again in ${Math.ceil(error.retryAfter! / 60_000)} minutes.`);
    });
  });

  test("without a message it says what the middleware says", async () => {
    await kernelContext.run(makeApp(), async () => {
      const one = { limit: 1, window: 60 };
      await RateLimiterFacade.enforce("k", one);
      const error = await thrown(() => RateLimiterFacade.enforce("k", one));
      expect(error.message).toBe("Rate limit exceeded");
    });
  });

  test("is on the service too, and validates like consume", async () => {
    const application = makeApp();
    const limiter = application.make(RateLimiter);
    await expect(limiter.enforce("k", { limit: 0 })).rejects.toThrow(/limit must be greater than zero/);
    await limiter.enforce("k", { limit: 1, window: 60 });
    await expect(limiter.enforce("k", { limit: 1, window: 60 })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  test("the client classifies the answer as rate_limit and keeps retryAfter", async () => {
    await kernelContext.run(makeApp(), async () => {
      const one = { limit: 1, window: 90 };
      await RateLimiterFacade.enforce("k", one, "Slow down");
      const error = await thrown(() => RateLimiterFacade.enforce("k", one, "Slow down"));

      const onClient = mutationErrorFromBody(error.payload.api.data, 429);

      expect(isRateLimitError(onClient)).toBe(true);
      expect(onClient).toEqual({
        kind: "rate_limit",
        message: "Slow down",
        status: 429,
        retryAfter: error.retryAfter,
      });
    });
  });
});
