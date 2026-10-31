import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { ApiRouter } from "../../http/ApiRouter";
import { CacheMiddleware } from "../../http/CacheMiddleware";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { privateWhenSettingCookies } from "./staticCache";

/**
 * A hydrated view sets `session_id` and `csrf_token`. Under `cache:public` a
 * shared cache could store one visitor's cookies with the page and replay them
 * to everyone, so a view response that sets a cookie is lowered to private,
 * keeping `max-age` (#1098). It never carries both `public`/`s-maxage` and
 * `Set-Cookie`.
 */

process.env.SECRET ??= "public-view-test-secret";

const Layout = (props: { children: ReactNode }) => (
  <html lang="en">
    <Head />
    <body>{props.children}</body>
  </html>
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  Page: () => <main>page</main>,
};

class SharedCache extends Middleware {
  run() {
    this.req.ctx().setHeaders("Cache-Control", "public, max-age=60, s-maxage=600, stale-while-revalidate=30");
  }
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/public": this.view("Page").middleware(["cache:public"]),
    "/shared": this.view("Page").middleware(["shared-cache"]),
    "/private": this.view("Page").middleware(["cache:private"]),
    "/static": this.view("Page").static({ cacheControl: "public, max-age=60" }),
    "/warn-a": this.view("Page").middleware(["cache:public"]),
    "/warn-b": this.view("Page").middleware(["cache:public"]),
  };
}

class TestKernel extends Kernel {
  config = {
    middleware: {
      aliases: { cache: CacheMiddleware, "shared-cache": SharedCache },
    },
    route: {
      api: { rootRouter: class extends ApiRouter {} },
      view: { root: createRoot(Layout), rootRouter: TestViewRouter },
    },
  };
}

const app = new App({ kernel: TestKernel });

const prodParams = {
  getStyles: async () => [],
  viewImportMap: views,
  viewModules: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { default: v }])),
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
  clientEntry: { module: "/assets/client.js", preload: ["/assets/client.js"] },
  modulePreloadManifest: {},
  resolveIsland: () => undefined,
};

async function fetchDocument(path: string, headers: Record<string, string> = {}) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`, { headers }));
  expect(typeof render).toBe("function");
  return (await (render as any)(prodParams)) as Response;
}

async function fetchJson(path: string, headers: Record<string, string> = {}) {
  const res = await app.fetch(new Request(`http://gemi.dev${path}.json`, { headers }));
  expect(res).toBeInstanceOf(Response);
  return res as Response;
}

const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

/** Never `public`/`s-maxage` together with a `Set-Cookie`. */
function expectNoSharedCookie(res: Response) {
  if (res.headers.getSetCookie().length > 0) {
    expect(res.headers.get("Cache-Control") ?? "").not.toMatch(/(^|[\s,])(public|s-maxage)\b/i);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a cache:public hydrated view", () => {
  test("the document keeps its cookies and is sent private, max-age kept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchDocument("/public");

    expect(res.status).toBe(200);
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["session_id", "csrf_token"]));
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=864000, stale-while-revalidate=300, stale-if-error=600",
    );
    expectNoSharedCookie(res);
  });

  test("the .json navigation of a first-time visitor is sent private too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchJson("/public");

    expect(res.status).toBe(200);
    expect(cookieNames(res)).toContain("session_id");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=864000, stale-while-revalidate=300, stale-if-error=600",
    );
    expectNoSharedCookie(res);
  });

  test("s-maxage is dropped, the browser's directives stay", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await fetchDocument("/shared");
    const json = await fetchJson("/shared");

    for (const res of [doc, json]) {
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=60, stale-while-revalidate=30");
      expectNoSharedCookie(res);
    }
  });

  test("warns once per route in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fetchDocument("/warn-a");
    await fetchJson("/warn-a");
    await fetchDocument("/warn-a");
    await fetchDocument("/warn-b");

    const messages = warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes("/warn-"));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"/warn-a"');
    expect(messages[0]).toContain("session_id");
    expect(messages[1]).toContain('"/warn-b"');
  });
});

describe("unchanged", () => {
  test("cache:private", async () => {
    const res = await fetchDocument("/private");
    expect(res.headers.get("Cache-Control")).toBe(
      "private, max-age=0, stale-while-revalidate=300, stale-if-error=600",
    );
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["session_id", "csrf_token"]));
  });

  test("a static view sets no cookie and stays public", async () => {
    const res = await fetchDocument("/static");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});

describe("privateWhenSettingCookies()", () => {
  const lower = (cacheControl: string | null, cookie = true) => {
    const headers = new Headers();
    if (cacheControl) headers.set("Cache-Control", cacheControl);
    if (cookie) headers.append("Set-Cookie", "a=1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    privateWhenSettingCookies(headers, `/unit-${Math.random()}`);
    return headers.get("Cache-Control");
  };

  test("rewrites only what a shared cache reads", () => {
    expect(lower("public, max-age=60")).toBe("private, max-age=60");
    expect(lower("max-age=60, s-maxage=600")).toBe("private, max-age=60");
    expect(lower("Public, S-MaxAge=600, proxy-revalidate, must-revalidate, immutable")).toBe(
      "private, must-revalidate, immutable",
    );
    expect(lower("public")).toBe("private");
  });

  test("leaves the header alone without a cookie or a shared directive", () => {
    expect(lower("public, max-age=60", false)).toBe("public, max-age=60");
    expect(lower("private, max-age=60")).toBe("private, max-age=60");
    expect(lower("no-store")).toBe("no-store");
    expect(lower(null)).toBeNull();
  });
});
