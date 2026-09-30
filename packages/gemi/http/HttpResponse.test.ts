import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { QueryError } from "../client/QueryError";
import { Query } from "../facades/Prefetch";
import { ApiRouter } from "./ApiRouter";
import { CacheMiddleware } from "./CacheMiddleware";
import { Controller } from "./Controller";
import { HttpRequest } from "./HttpRequest";
import { HttpResponse, isHttpResponse } from "./HttpResponse";
import { Middleware } from "./Middleware";
import { ViewRouter } from "./ViewRouter";
import { Kernel } from "../kernel";

/**
 * `HttpResponse.json` through a whole `App`: the status and headers it names,
 * on top of everything a plain return would have carried.
 */

// What `CorsMiddleware` does, plus a cookie: a refreshed session, say.
class ContextMiddleware extends Middleware {
  run() {
    const ctx = this.req.ctx();
    ctx.setHeaders("Access-Control-Allow-Origin", "https://app.example");
    ctx.setHeaders("X-Context", "context");
    ctx.setCookie("session", "refreshed");
    return {};
  }
}

class PostController extends Controller {
  async store(req = new HttpRequest()) {
    return HttpResponse.json({ id: 7, method: req.rawRequest.method }, { status: 201 });
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/plain": this.get(() => ({ a: 1 })).middleware(["context"]),
    "/created": this.post(() => HttpResponse.json({ a: 1 }, { status: 201 })).middleware([
      "context",
    ]),
    "/default-status": this.get(() => HttpResponse.json({ a: 1 })),
    "/posts": this.post(PostController, "store"),
    "/handler-context": this.get((req = new HttpRequest()) => {
      req.ctx().setHeaders("X-From-Handler", "handler");
      req.ctx().setCookie("handler", "1");
      return HttpResponse.json({ ok: true }, { status: 202 });
    }),
    "/override": this.get(() =>
      HttpResponse.json(
        { ok: true },
        {
          headers: {
            "X-Context": "option",
            "Content-Type": "application/problem+json",
            "Set-Cookie": "extra=1; Path=/",
          },
        },
      ),
    ).middleware(["context"]),
    "/header-pairs": this.get(() =>
      HttpResponse.json(
        {},
        {
          headers: [
            ["Set-Cookie", "one=1"],
            ["Set-Cookie", "two=2"],
          ],
        },
      ),
    ),
    "/conflict": this.post(() =>
      HttpResponse.json({ error: { message: "Taken" } }, { status: 409 }),
    ).middleware(["context"]),
    "/cached": this.get(() => HttpResponse.json({ a: 1 })).middleware(["cache"]),
    "/cached/missing": this.get(() =>
      HttpResponse.json({ error: { message: "Not found" } }, { status: 404 }),
    ).middleware(["cache"]),
    "/cached/missing-own-cache": this.get(() =>
      HttpResponse.json(
        { error: { message: "Not found" } },
        { status: 404, headers: { "Cache-Control": "public, max-age=60" } },
      ),
    ).middleware(["cache"]),
    "/cached/created": this.get(() => HttpResponse.json({ a: 1 }, { status: 203 })).middleware([
      "cache",
    ]),
    "/null": this.get(() => HttpResponse.json(null, { status: 422 })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/instant-created": this.view("InstantCreated", async () => ({
      data: await (Query as any).instant("/default-status"),
    })),
    "/instant-missing": this.view("InstantMissing", async () => {
      try {
        await (Query as any).instant("/cached/missing");
        return { caught: null };
      } catch (err) {
        return {
          caught: {
            isQueryError: err instanceof QueryError,
            status: err.status,
            body: err.body,
          },
        };
      }
    }),
    "/view-response": this.view("ViewResponse", () => HttpResponse.json({ a: 1 }) as any),
  };
}

const failed: unknown[] = [];

class AppKernel extends Kernel {
  config = {
    middleware: {
      aliases: {
        context: ContextMiddleware,
        cache: CacheMiddleware,
      },
    },
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: () => createElement("div"),
        rootRouter: RootViewRouter,
        onRequestFail: (_req: HttpRequest, error: unknown) => {
          failed.push(error);
        },
      },
    },
  };
}

const app = new App({ kernel: AppKernel });

async function fetchApi(path: string, init?: RequestInit) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev/api${path}`, init));
  expect(result).toBeInstanceOf(Response);
  return result as Response;
}

beforeEach(() => {
  failed.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpResponse.json", () => {
  test("answers its status, the JSON body and a JSON content type", async () => {
    const res = await fetchApi("/created", { method: "POST" });

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ a: 1 });
  });

  test("defaults to 200", async () => {
    const res = await fetchApi("/default-status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: 1 });
  });

  test("works from a controller method", async () => {
    const res = await fetchApi("/posts", { method: "POST" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 7, method: "POST" });
  });

  test("carries the headers and cookies middleware set, as a plain return does", async () => {
    const plain = await fetchApi("/plain");
    const res = await fetchApi("/created", { method: "POST" });

    for (const r of [plain, res]) {
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
      expect(r.headers.get("X-Context")).toBe("context");
      expect(r.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=refreshed/)]);
    }
  });

  test("carries the headers and cookies the handler set on the context", async () => {
    const res = await fetchApi("/handler-context");

    expect(res.status).toBe(202);
    expect(res.headers.get("X-From-Handler")).toBe("handler");
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^handler=1/)]);
  });

  test("an option header replaces the context's, and a Set-Cookie adds to them", async () => {
    const res = await fetchApi("/override");

    expect(res.headers.get("X-Context")).toBe("option");
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    // The middleware's header it did not name is kept.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(res.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^session=refreshed/),
      "extra=1; Path=/",
    ]);
  });

  test("several Set-Cookie options all arrive", async () => {
    const res = await fetchApi("/header-pairs");

    expect(res.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
  });

  test("an error status answers its JSON body with the context's headers", async () => {
    const res = await fetchApi("/conflict", { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { message: "Taken" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(res.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=refreshed/)]);
  });

  test("a JSON null body is still JSON", async () => {
    const res = await fetchApi("/null");

    expect(res.status).toBe(422);
    expect(await res.text()).toBe("null");
  });
});

describe("HttpResponse.json behind `cache`", () => {
  const cacheable = "public, max-age=864000, stale-while-revalidate=300, stale-if-error=600";

  test("a 2xx keeps the route's Cache-Control", async () => {
    const ok = await fetchApi("/cached");
    const nonAuthoritative = await fetchApi("/cached/created");

    expect([ok.status, ok.headers.get("Cache-Control")]).toEqual([200, cacheable]);
    expect([nonAuthoritative.status, nonAuthoritative.headers.get("Cache-Control")]).toEqual([
      203,
      cacheable,
    ]);
  });

  test("a 4xx is no-store, as gemi's own errors are", async () => {
    const res = await fetchApi("/cached/missing");

    expect([res.status, res.headers.get("Cache-Control")]).toEqual([404, "no-store"]);
  });

  test("a 4xx that names its own Cache-Control keeps it", async () => {
    const res = await fetchApi("/cached/missing-own-cache");

    expect([res.status, res.headers.get("Cache-Control")]).toEqual([404, "public, max-age=60"]);
  });
});

describe("HttpResponse behind a view loader's Query.instant", () => {
  test("a 2xx resolves to the body", async () => {
    const res = (await app.fetch(new Request("http://gemi.dev/instant-created.json"))) as Response;

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('"data":{"a":1}');
  });

  test("a 4xx rejects with a QueryError carrying the status and body, as in the browser", async () => {
    const res = (await app.fetch(new Request("http://gemi.dev/instant-missing.json"))) as Response;

    expect(JSON.stringify(await res.json())).toContain(
      JSON.stringify({
        caught: {
          isQueryError: true,
          status: 404,
          body: { error: { message: "Not found" } },
        },
      }).slice(1, -1),
    );
  });
});

describe("HttpResponse in a view handler", () => {
  test("fails the request rather than rendering its fields as props", async () => {
    await app.fetch(new Request("http://gemi.dev/view-response.json")).catch(() => null);

    expect(failed).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/HttpResponse is for api routes/) }),
    ]);
  });
});

describe("HttpResponse.json's arguments", () => {
  test("refuses a status that cannot carry a JSON body", () => {
    expect(() => HttpResponse.json({}, { status: 204 })).toThrow(RangeError);
    expect(() => HttpResponse.json({}, { status: 304 })).toThrow(RangeError);
    expect(() => HttpResponse.json({}, { status: 99 })).toThrow(RangeError);
    expect(() => HttpResponse.json({}, { status: 600 })).toThrow(RangeError);
    expect(() => HttpResponse.json({}, { status: 201.5 })).toThrow(RangeError);
  });

  test("is recognised by its brand, not by instanceof", () => {
    const res = HttpResponse.json({ a: 1 }, { status: 201 });
    expect(isHttpResponse(res)).toBe(true);
    expect(isHttpResponse({ ...res })).toBe(true);
    expect(isHttpResponse({ kind: "json", body: {}, status: 200 })).toBe(false);
    expect(isHttpResponse(new Response("{}"))).toBe(false);
    expect([res.status, res.ok, res.body]).toEqual([201, true, { a: 1 }]);
  });
});
