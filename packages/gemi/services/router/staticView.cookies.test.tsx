import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { Head } from "../../client/Head";
import { island } from "../../client/islands";
import { Cookie } from "../../facades/Cookie";
import { ApiRouter } from "../../http/ApiRouter";
import { Middleware } from "../../http/Middleware";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { RecordNotFoundError } from "../../orm/errors";
import { ISLAND_LOADER_SOURCE } from "./staticDocument";

/**
 * A `.static()` view is one body for every visitor, so gemi sets none of its
 * own cookies on it — `session_id`, `csrf_token`, `i18n-locale` — and a CDN
 * can cache it. `cacheControl` says for how long.
 */

process.env.SECRET ??= "static-view-test-secret";

const Layout = (props: { children: ReactNode; locale: string }) => (
  <html lang={props.locale}>
    <Head />
    <body>{props.children}</body>
  </html>
);

/** What gemi's Vite plugin turns `island(() => import("./Counter"))`'s loader into. */
const counterModule = { default: (props: { start: number }) => <button type="button">{props.start}</button> };
const Counter = island(
  Object.assign(() => Promise.resolve(counterModule), {
    gemiIsland: "app/views/Counter.tsx",
    gemiModule: counterModule,
  }) as () => Promise<any>,
);

const views: Record<string, any> = {
  "404": () => <p>not found</p>,
  Page: () => (
    <main>
      <form method="post" action="/api/form/abc">
        <input name="email" />
      </form>
    </main>
  ),
  Hydrated: () => <main>hydrated</main>,
  WithIsland: () => (
    <main>
      <Counter start={3} />
    </main>
  ),
};

const submitted: unknown[] = [];

class AnyOrigin extends Middleware {
  run() {
    this.req.ctx().setHeaders("Access-Control-Allow-Origin", "*");
  }
}

class GlobalCookie extends Middleware {
  run() {
    if (this.req.headers.get("x-global-cookie")) {
      this.req.ctx().setCookie("global_seen", "1");
    }
  }
}

class TestApiRouter extends ApiRouter {
  routes = {
    "/form/:formId": this.post(() => {
      submitted.push("submitted");
      return { ok: true };
    }).middleware(["any-origin"]),
  };
}

class TestViewRouter extends ViewRouter {
  routes = {
    "/plain": this.view("Page").static(),
    "/cached": this.view("Page").static({
      cacheControl: "public, max-age=60, s-maxage=600",
    }),
    "/cached-own-header": this.view("Page", (req) => {
      req.ctx().setHeaders("Cache-Control", "public, max-age=5");
      return {};
    }).static({ cacheControl: "public, max-age=60" }),
    "/sets-cookie": this.view("Page", () => {
      Cookie.set("visited", "1", {});
      return {};
    }).static({ cacheControl: "public, max-age=60" }),
    "/with-session": this.view("Page").static({ session: true }),
    "/with-csrf": this.view("Page").static({ csrf: true }),
    "/missing": this.view("Page", () => {
      throw new RecordNotFoundError("Page", "findUniqueOrThrow");
    }).static({ cacheControl: "public, max-age=60" }),
    "/hydrated": this.view("Hydrated"),
    "/with-island": this.view("WithIsland").static({ cacheControl: "public, max-age=60" }),
  };
}

class TestKernel extends Kernel {
  config = {
    middleware: {
      aliases: { "any-origin": AnyOrigin, "global-cookie": GlobalCookie },
      global: ["global-cookie"],
    },
    route: {
      api: { rootRouter: TestApiRouter },
      view: {
        root: createRoot(Layout),
        rootRouter: TestViewRouter,
      },
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
  resolveIsland: (key: string) =>
    key === "app/views/Counter.tsx"
      ? { src: "/assets/Counter.js", preload: ["/assets/Counter.js", "/assets/react-dom.js"] }
      : undefined,
};

async function fetchDocument(path: string, headers: Record<string, string> = {}) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`, { headers }));
  expect(typeof render).toBe("function");
  return (await (render as any)(prodParams)) as Response;
}

const cookieNames = (res: Response) => res.headers.getSetCookie().map((c) => c.split("=")[0]);

afterEach(() => {
  vi.restoreAllMocks();
  submitted.length = 0;
});

describe("a static view's cookies", () => {
  test("a first-time visitor gets no Set-Cookie at all", async () => {
    const res = await fetchDocument("/plain");

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    // No cacheControl, no header: the cache in front decides.
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  test("a page with an island sets none either, and still gets the island loader", async () => {
    const res = await fetchDocument("/with-island");
    const html = await res.text();

    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(html).toContain("<gemi-island");
    expect(html).toContain("<button");
    expect(html).toContain(`${ISLAND_LOADER_SOURCE}</script>`);
    expect(html).toContain('"s":"/assets/Counter.js"');
    // Still no client runtime: the island's chunk is the only script it loads.
    expect(html).not.toContain("/assets/client.js");
  });

  test("a hydrated view still sets session_id, csrf_token and i18n-locale", async () => {
    const res = await fetchDocument("/hydrated");

    expect(cookieNames(res)).toEqual(
      expect.arrayContaining(["session_id", "csrf_token", "i18n-locale"]),
    );
  });

  test("`session: true` mints session_id, and only that", async () => {
    const res = await fetchDocument("/with-session");
    expect(cookieNames(res)).toEqual(["session_id"]);
  });

  test("`csrf: true` sets csrf_token, and only that", async () => {
    const res = await fetchDocument("/with-csrf");
    expect(cookieNames(res)).toEqual(["csrf_token"]);
  });

  test("a missing record renders the hydrated 404, with a hydrated page's cookies and no cache header", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetchDocument("/missing");

    expect(res.status).toBe(404);
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["session_id", "csrf_token"]));
    expect(res.headers.get("Cache-Control") ?? "").not.toContain("public");
  });
});

describe("a static view's Cache-Control", () => {
  test("is the cacheControl option", async () => {
    const res = await fetchDocument("/cached");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=600");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("is the handler's own header when it set one", async () => {
    const res = await fetchDocument("/cached-own-header");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
  });

  test("turns private when the handler set a cookie, so no shared cache stores it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await fetchDocument("/sets-cookie");

    expect(cookieNames(res)).toEqual(["visited"]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(warn).toHaveBeenCalled();
  });

  test("a global middleware's cookie is left off a page a shared cache may store", async () => {
    const res = await fetchDocument("/cached", { "x-global-cookie": "1" });

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=600");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("a form on a static page", () => {
  test("posts to an api route that does not depend on the page's cookies", async () => {
    const page = await fetchDocument("/plain");
    expect(await page.text()).toContain('action="/api/form/abc"');

    // A cross-origin POST with no cookies, as a browser sends from a cached
    // copy of the page.
    const res = (await app.fetch(
      new Request("http://gemi.dev/api/form/abc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://elsewhere.example" },
        body: JSON.stringify({ email: "a@b.c" }),
      }),
    )) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(submitted).toEqual(["submitted"]);
  });
});
