import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { CorsMiddleware } from "../../http/CorsMiddleware";
import { RequestBreakerError } from "../../http/Error";
import { HttpRequest } from "../../http/HttpRequest";
import { Middleware } from "../../http/Middleware";
import { RateLimitMiddleware } from "../../http/RateLimitMiddleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

process.env.SECRET ??= "test-secret";

/**
 * A refusal from a middleware listed before `cors` — a router's inherited
 * `rate-limit`, a `body-limit`, a middleware that reads the body — still
 * carries the CORS headers, so a browser sees the 413, 400 or 429 instead of a
 * network error.
 */

const ALLOWED = "https://site.example";

const Cors = CorsMiddleware.configure({
  origins: { [ALLOWED]: { "Access-Control-Allow-Methods": "GET, POST" } },
});
const AnyOriginCors = CorsMiddleware.configure({
  origins: { "*": { "Access-Control-Allow-Methods": "POST" } },
});

/** Reads the body before `cors` runs, as a honeypot check would. */
class ReadsBody extends Middleware {
  async run() {
    await this.req.input();
    return {};
  }
}

class Refuses extends Middleware {
  run() {
    throw new RequestBreakerError("refused");
  }
}

class Crashes extends Middleware {
  run() {
    throw new Error("middleware crashed");
  }
}

/** Opts in, then throws after a refusal: logged, the refusal stands. */
class BrokenHeaders extends Middleware {
  static override runsOnRefusal = true;
  run() {
    throw new Error("headers crashed");
  }
}

class HeaderOnly extends Middleware {
  static override runsOnRefusal = true;
  run() {
    this.req.ctx().setHeaders("X-After", "ran");
    return {};
  }
}

const handled: string[] = [];

class LimitedRouter extends ApiRouter {
  middlewares = ["rate-limit:1,60"];
  routes = {
    "/": this.get(() => {
      handled.push("limited");
      return { ok: true };
    }).middleware(["cors"]),
  };
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/upload": this.post(() => {
      handled.push("upload");
      return { ok: true };
    }).middleware(["body-limit:16", "cors"]),
    "/upload-cors-first": this.post(() => ({ ok: true })).middleware(["cors", "body-limit:16"]),
    "/parse": this.post(() => ({ ok: true })).middleware(["reads-body", "cors"]),
    "/parse-in-handler": this.post(async (req = new HttpRequest()) => {
      await req.input();
      return { ok: true };
    }).middleware(["cors"]),
    "/limited": LimitedRouter,
    "/form": this.post(() => ({ ok: true })).middleware(["body-limit:16", "any-origin-cors"]),
    "/broken-after": this.post(() => ({ ok: true })).middleware([
      "refuses",
      "broken-headers",
      "header-only",
      "cors",
    ]),
    "/crash": this.post(() => ({ ok: true })).middleware(["crashes", "cors"]),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home", () => ({})),
  };
}

class TestKernel extends Kernel {
  config = {
    middleware: {
      aliases: {
        cors: Cors,
        "any-origin-cors": AnyOriginCors,
        "rate-limit": RateLimitMiddleware,
        "reads-body": ReadsBody,
        refuses: Refuses,
        crashes: Crashes,
        "broken-headers": BrokenHeaders,
        "header-only": HeaderOnly,
      },
    },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: RootViewRouter,
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://gemi.dev/api${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // As a browser sends it: `body-limit` refuses a declared length before
        // anything runs after it.
        "Content-Length": String(Buffer.byteLength(body)),
        Origin: ALLOWED,
        ...headers,
      },
      body,
    }),
  ) as Promise<Response>;
}

const big = JSON.stringify({ text: "x".repeat(200) });

beforeEach(() => {
  handled.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("CORS on a refusal from a middleware before cors", () => {
  test("413 from body-limit", async () => {
    const res = await post("/upload", big);

    expect(res.status).toBe(413);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST");
    expect(handled).toEqual([]);
  });

  test("413 from body-limit after cors, as before", async () => {
    const res = await post("/upload-cors-first", big);

    expect(res.status).toBe(413);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  test("400 from a body that is not JSON, read by a middleware", async () => {
    const res = await post("/parse", "{not json");

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  test("400 from a body that is not JSON, read by the handler", async () => {
    const res = await post("/parse-in-handler", "{not json");

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });

  test("429 from a rate-limit the router's middleware puts before the route's cors", async () => {
    const get = () =>
      app.fetch(
        new Request("http://gemi.dev/api/limited", {
          headers: { Origin: ALLOWED, "x-forwarded-for": "9.9.9.9" },
        }),
      ) as Promise<Response>;

    expect((await get()).status).toBe(200);
    const res = await get();

    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(handled).toEqual(["limited"]);
  });

  test("no CORS headers for an origin cors does not allow", async () => {
    const res = await post("/upload", big, { Origin: "https://evil.example" });

    expect(res.status).toBe(413);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("a runsOnRefusal middleware that throws is logged, and the refusal stands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post("/broken-after", "{}");

    expect(res.status).toBe(400);
    expect(res.headers.get("X-After")).toBe("ran");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(error).toHaveBeenCalled();
  });

  test("a middleware that crashes still goes on to the server's 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(post("/crash", "{}")).rejects.toThrow("middleware crashed");
  });
});

describe('CorsMiddleware with a "*" origin', () => {
  test("allows any origin, without credentials, on a refusal too", async () => {
    const res = await post("/form", big, { Origin: "https://published.example" });

    expect(res.status).toBe(413);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("allows any origin on success", async () => {
    const res = await post("/form", "{}", { Origin: "https://published.example" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
