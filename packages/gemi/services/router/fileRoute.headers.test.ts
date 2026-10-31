import { afterEach, describe, expect, test, vi } from "vitest";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Cookie } from "../../facades/Cookie";
import { ApiRouter } from "../../http/ApiRouter";
import { CacheMiddleware } from "../../http/CacheMiddleware";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A `this.file(...)` view route is an asset (#1094): it carries the request
 * context's headers whatever the handler returns, gets none of gemi's own
 * cookies, and never sends a cookie on a response a shared cache may store.
 */

process.env.SECRET ??= "file-route-test-secret";

class SetsCookie extends Middleware {
  run() {
    this.req.ctx().setCookie("seen", "1");
  }
}

class TestApiRouter extends ApiRouter {
  routes = {};
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/image": this.file((req) => {
      req.ctx().setHeaders("Vary", "Range");
      return new Response("bytes", {
        headers: { "Content-Type": "image/png", "X-Own": "response" },
      });
    }).middleware(["cache:public"]),
    "/own-cache": this.file(
      () => new Response("bytes", { headers: { "Cache-Control": "private, max-age=5" } }),
    ).middleware(["cache:public"]),
    "/favicon.ico": this.file(() => ({
      file: new File(["ico"], "favicon.ico", { type: "image/x-icon" }),
    })).middleware(["cache:public", "sets-cookie"]),
    "/public-response-cookie": this.file(() => {
      Cookie.set("visited", "1", {});
      return new Response("bytes");
    }).middleware(["cache:public"]),
    "/private": this.file(() => new File(["x"], "x.txt")).middleware([
      "cache:private",
      "sets-cookie",
    ]),
    "/abs": this.file(() => ({ file: Bun.file("/abs/dir/x.ico") })),
  };
}

class TestKernel extends Kernel {
  config = {
    middleware: {
      aliases: { cache: CacheMiddleware, "sets-cookie": SetsCookie },
    },
    route: {
      api: { rootRouter: TestApiRouter },
      view: {
        root: createRoot((props: { children: any }) => props.children),
        rootRouter: TestViewRouter,
      },
    },
  };
}

const app = new App({ kernel: TestKernel });

async function get(path: string): Promise<Response> {
  const out = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(out).toBeInstanceOf(Response);
  return out as Response;
}

const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a file route", () => {
  test("a returned Response carries the context's headers, its own winning", async () => {
    const res = await get("/image");

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=864000, stale-while-revalidate=300, stale-if-error=600",
    );
    expect(res.headers.get("Vary")).toBe("Range");
    expect(res.headers.get("X-Own")).toBe("response");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await res.text()).toBe("bytes");
  });

  test("a Cache-Control the Response sets itself is kept", async () => {
    const res = await get("/own-cache");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=5");
  });

  test("a public file sends no Set-Cookie, a first-time visitor's included", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await get("/favicon.ico");

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("Content-Type")).toBe("image/x-icon");
    // The middleware's own cookie was dropped, and that is reported.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("/favicon.ico");
  });

  test("a public Response loses a cookie the handler set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await get("/public-response-cookie");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("a private file keeps the app's cookie and gets no session_id", async () => {
    const res = await get("/private");

    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(cookieNames(res)).toEqual(["seen"]);
  });

  test("a Bun.file without a name is named by its base name, not its path", async () => {
    const original = Bun.file;
    // The path does not exist; only its name matters here.
    vi.spyOn(Bun, "file").mockImplementation(((path: string) => {
      const file = original(path);
      return Object.assign(new Blob(["x"]), {
        name: file.name,
        exists: async () => true,
      });
    }) as any);

    const res = await get("/abs");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toBe(`inline; filename="x.ico"; filename*=UTF-8''x.ico`);
    expect(disposition).not.toContain("/abs/dir");
  });
});
