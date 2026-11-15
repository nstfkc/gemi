import { describe, expect, test } from "vitest";

import { RequestBreakerError } from "../../http/Error";
import { Middleware } from "../../http/Middleware";
import { Kernel } from "../../kernel";

/**
 * A kernel that only configures middleware (an app's unit test running its
 * real global list, with no `route` config) gets a global middleware's
 * refusal back without resolving the router (#1277).
 */

process.env.SECRET ??= "global-middleware-no-routes-test-secret";

class TooManyRequests extends RequestBreakerError {
  constructor() {
    super("too many requests");
    this.payload = {
      api: { status: 429, data: { error: "slow down" } },
      view: { status: 429, error: { message: "slow down" } },
    };
  }
}

class RateLimit extends Middleware {
  run() {
    throw new TooManyRequests();
  }
}

class MiddlewareOnlyKernel extends Kernel {
  config = {
    middleware: { aliases: { "rate-limit": RateLimit }, global: ["rate-limit"] },
  };
}

async function refuse(path: string) {
  const kernel = new MiddlewareOnlyKernel();
  // Registered, not booted: booting would build the route dispatchers, which
  // need the route config this kernel leaves out.
  kernel.boot();
  try {
    return await kernel.run(() => kernel.globalMiddleware(new Request(`http://gemi.dev${path}`)));
  } finally {
    kernel.destroy();
  }
}

describe("a global middleware refusal with no route config", () => {
  test("at a non-.json path returns the plain refusal and does not throw", async () => {
    const { refusal } = await refuse("/auth/sign-in/magic-link");
    expect(refusal).toBeInstanceOf(Response);
    expect(refusal!.status).toBe(429);
    expect(await refusal!.text()).toBe("slow down");
  });

  test("at a .json path falls back to the view data refusal and does not throw", async () => {
    const { refusal } = await refuse("/dashboard.json");
    expect(refusal).toBeInstanceOf(Response);
    expect(refusal!.status).toBe(429);
    expect(await refusal!.json()).toEqual({ data: { error: "slow down" } });
  });
});
