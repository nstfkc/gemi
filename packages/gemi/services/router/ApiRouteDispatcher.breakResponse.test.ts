import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { AuthorizationError } from "../../http/errors";
import { Middleware } from "../../http/Middleware";
import { RateLimitExceededError } from "../../http/RateLimitMiddleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { PolicyDeniedError } from "../../orm/errors";

/**
 * A middleware that rejects a request answers with what the middleware before
 * it put on the context, as a handler's Response does: `cors` runs first, and
 * a 401, 429 or 403 without its headers reaches the browser as an opaque CORS
 * failure instead of the status.
 */

// What `CorsMiddleware` does, plus a cookie: a refreshed session, say.
class ContextMiddleware extends Middleware {
  run() {
    const ctx = this.req.ctx();
    ctx.setHeaders("Access-Control-Allow-Origin", "https://app.example");
    // Collides with the rate limiter's own header, which must win.
    ctx.setHeaders("Retry-After", "999");
    ctx.setCookie("session", "refreshed");
    return {};
  }
}

class Unauthorized extends Middleware {
  run(): {} {
    throw new AuthorizationError();
  }
}

class Limited extends Middleware {
  run(): {} {
    throw new RateLimitExceededError({
      allowed: false,
      limit: 1,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfter: 30_000,
    });
  }
}

// A membership check that loads a policied model and is refused.
class Denied extends Middleware {
  run(): {} {
    throw new PolicyDeniedError("Membership", "findFirst");
  }
}

const handled: string[] = [];

class RootApiRouter extends ApiRouter {
  routes = {
    "/unauthorized": this.get(() => {
      handled.push("/unauthorized");
      return {};
    }).middleware(["context", "unauthorized"]),
    "/limited": this.get(() => {
      handled.push("/limited");
      return {};
    }).middleware(["context", "limited"]),
    "/denied": this.get(() => {
      handled.push("/denied");
      return {};
    }).middleware(["context", "denied"]),
  };
}

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: {
        context: ContextMiddleware,
        unauthorized: Unauthorized,
        limited: Limited,
        denied: Denied,
      },
    },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

beforeEach(() => {
  handled.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a middleware's break response", () => {
  test("a 401 after a middleware that set a header carries that header", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/unauthorized"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authorized" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(handled).toEqual([]);
  });

  test("a Set-Cookie from before the break survives it", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/unauthorized"));

    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=refreshed/)]);
  });

  test("the breaker's own header wins over a context header of the same name", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/limited"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    // Gaps are still filled.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(handled).toEqual([]);
  });

  test("a policy denial raised by a middleware answers 403 with the context's headers and cookies", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/denied"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Forbidden" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=refreshed/)]);
    expect(handled).toEqual([]);
  });
});
