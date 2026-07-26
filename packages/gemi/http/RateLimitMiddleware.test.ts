import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Application } from "../foundation/Application";
import { kernelContext } from "../kernel/context";
import { InMemoryRateLimiter } from "../services/rate-limiter/drivers/InMemoryRateLimiterDriver";
import { RateLimiterServiceProvider } from "../services/rate-limiter/RateLimiterServiceProvider";
import { Repository } from "../support/Repository";
import type { RateLimiterConfig } from "../services/rate-limiter/config";
import { HttpRequest } from "./HttpRequest";
import { RateLimitMiddleware } from "./RateLimitMiddleware";
import { RequestContext } from "./requestContext";

/**
 * An Application with only the rate limiter registered. Each call builds a new
 * one, so a test's counters never leak into the next — pass the same instance
 * to `runMiddleware` twice to share a budget across requests.
 */
function makeApp(config: RateLimiterConfig = {}) {
  const application = new Application(new Repository({ ratelimiter: config }));
  application.register(RateLimiterServiceProvider);
  return application;
}

/**
 * Runs `middleware.run(...)` the way the router does: inside a kernel context
 * holding an Application that has the rate limiter registered, and inside a
 * request context so the middleware can set response headers.
 */
function runMiddleware(options: {
  Middleware?: typeof RateLimitMiddleware;
  app?: Application;
  headers?: Record<string, string>;
  routePath?: string;
  args?: (string | number)[];
}) {
  const application = options.app ?? makeApp();

  const request = new HttpRequest(
    new Request("http://localhost/api/search", {
      headers: options.headers ?? { "x-forwarded-for": "1.2.3.4" },
    }),
    {},
    "api",
    options.routePath ?? "/search",
  );

  const MiddlewareClass = options.Middleware ?? RateLimitMiddleware;

  return kernelContext.run(application, () =>
    RequestContext.run(request, async () => {
      const middleware = new MiddlewareClass(request);
      try {
        await middleware.run(...((options.args ?? []) as []));
        return {
          rejected: false as const,
          headers: RequestContext.getStore().headers,
        };
      } catch (error) {
        return {
          rejected: true as const,
          error: error as any,
          headers: RequestContext.getStore().headers,
        };
      }
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("run", () => {
  test("passes requests under the limit and reports the budget", async () => {
    const app = makeApp();

    const first = await runMiddleware({ app, args: ["3", "60"] });

    expect(first.rejected).toBe(false);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("2");
    // Epoch seconds of the end of the current 60s window.
    expect(first.headers.get("X-RateLimit-Reset")).toBe("120");
    expect(first.headers.get("Retry-After")).toBe(null);
  });

  test("rejects with a 429 and a Retry-After once the budget is spent", async () => {
    const app = makeApp();
    const args = ["2", "60"];

    await runMiddleware({ app, args });
    await runMiddleware({ app, args });
    const third = await runMiddleware({ app, args });

    expect(third.rejected).toBe(true);
    expect(third.error.payload.api.status).toBe(429);
    // The whole budget went in at the start of the window, so half of the next
    // one has to pass before a request fits again.
    expect(third.error.payload.api.headers["Retry-After"]).toBe("90");
    expect(third.error.payload.api.headers["X-RateLimit-Remaining"]).toBe("0");
    // The router builds the 429 from the payload, so the headers have to be
    // there too — not only on the request context.
    expect(third.error.payload.view.status).toBe(429);
  });

  test("keys by client and route, so one route cannot spend another's budget", async () => {
    const app = makeApp();
    const args = ["1", "60"];

    await runMiddleware({ app, args, routePath: "/search" });

    const sameRoute = await runMiddleware({
      app,
      args,
      routePath: "/search",
    });
    const otherRoute = await runMiddleware({
      app,
      args,
      routePath: "/upload",
    });
    const otherClient = await runMiddleware({
      app,
      args,
      routePath: "/search",
      headers: { "x-forwarded-for": "5.6.7.8" },
    });

    expect(sameRoute.rejected).toBe(true);
    expect(otherRoute.rejected).toBe(false);
    expect(otherClient.rejected).toBe(false);
  });

  test("reads only the left-most x-forwarded-for entry", async () => {
    const app = makeApp();
    const args = ["1", "60"];

    await runMiddleware({
      app,
      args,
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });

    // Same client, different proxy chain: it must not buy a fresh budget.
    const second = await runMiddleware({
      app,
      args,
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.9, 10.0.0.7" },
    });

    expect(second.rejected).toBe(true);
  });

  test("falls back to x-real-ip", async () => {
    const app = makeApp();
    const args = ["1", "60"];
    const headers = { "x-real-ip": "9.9.9.9" };

    await runMiddleware({ app, args, headers });
    const second = await runMiddleware({ app, args, headers });
    const other = await runMiddleware({
      app,
      args,
      headers: { "x-real-ip": "8.8.8.8" },
    });

    expect(second.rejected).toBe(true);
    expect(other.rejected).toBe(false);
  });

  test("falls back to the configured defaults when the DSL passes nothing", async () => {
    const app = makeApp({
      driver: new InMemoryRateLimiter(),
      limit: 1,
      window: 30,
    });

    const first = await runMiddleware({ app });
    const second = await runMiddleware({ app });

    expect(first.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(second.rejected).toBe(true);
  });

  test("ignores unusable DSL parameters instead of limiting to zero", async () => {
    const app = makeApp();

    const result = await runMiddleware({ app, args: ["abc", "0"] });

    expect(result.rejected).toBe(false);
    expect(result.headers.get("X-RateLimit-Limit")).toBe("1000");
  });

  test("takes the limit from configure() when the DSL omits one", async () => {
    const app = makeApp();
    const Configured = RateLimitMiddleware.configure({
      limit: 1,
      window: 60,
    }) as typeof RateLimitMiddleware;

    const first = await runMiddleware({ app, Middleware: Configured });
    const second = await runMiddleware({ app, Middleware: Configured });

    expect(first.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(second.rejected).toBe(true);
  });

  test("lets configure() replace what counts as one client", async () => {
    const app = makeApp();
    const Configured = RateLimitMiddleware.configure({
      limit: 1,
      key: () => "tenant:acme",
    }) as typeof RateLimitMiddleware;

    await runMiddleware({ app, Middleware: Configured });
    // Different IP and route, same tenant — one shared budget.
    const second = await runMiddleware({
      app,
      Middleware: Configured,
      routePath: "/upload",
      headers: { "x-forwarded-for": "5.6.7.8" },
    });

    expect(second.rejected).toBe(true);
  });

  test("can be told not to set headers", async () => {
    const app = makeApp();
    const Configured = RateLimitMiddleware.configure({
      headers: false,
    }) as typeof RateLimitMiddleware;

    const result = await runMiddleware({ app, Middleware: Configured });

    expect(result.headers.get("X-RateLimit-Limit")).toBe(null);
  });
});

describe("invalid configuration", () => {
  test("says so instead of limiting in an unexplainable way", async () => {
    const result = await runMiddleware({ app: makeApp({ window: 0 }) });

    expect(result.rejected).toBe(true);
    expect(result.error.message).toMatch(/window must be greater than zero/);
  });
});

describe("without a limiter", () => {
  function runWithout(store: unknown) {
    const request = new HttpRequest(
      new Request("http://localhost/api/search"),
      {},
      "api",
      "/search",
    );

    return kernelContext.run(store, () =>
      RequestContext.run(request, () =>
        new RateLimitMiddleware(request).run("1"),
      ),
    );
  }

  test("does not reject requests when there is no application", async () => {
    expect(await runWithout({})).toEqual({});
  });

  test("does not reject requests when the service is not bound", async () => {
    const application = new Application(new Repository());

    expect(await runWithout(application)).toEqual({});
  });
});
