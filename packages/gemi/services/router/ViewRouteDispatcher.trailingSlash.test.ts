import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

process.env.SECRET ??= "trailing-slash-test-secret";

class DocsViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Docs"),
    "/:path*": this.view("Docs"),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
    "/posts/:slug": this.view("Post"),
    "/docs": DocsViewRouter,
  };
}

class RootApiRouter extends ApiRouter {
  routes = {};
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: () => createElement("div"), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: AppKernel });

async function fetchView(path: string, method = "GET") {
  return (await app.fetch(new Request(`http://gemi.dev${path}`, { method }))) as unknown;
}

describe("a view path with a trailing slash", () => {
  test.each([
    ["/about/", "/about"],
    ["/about//", "/about"],
    ["/about/?x=1&y=2", "/about?x=1&y=2"],
    ["/posts/hello/", "/posts/hello"],
    ["/docs/a/b/", "/docs/a/b"],
    ["/docs/", "/docs"],
    ["/nowhere/", "/nowhere"],
  ])("redirects %s to %s for good", async (from, to) => {
    const res = await fetchView(from);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(301);
    expect((res as Response).headers.get("Location")).toBe(to);
  });

  test("a HEAD request is redirected too", async () => {
    const res = (await fetchView("/about/", "HEAD")) as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/about");
  });

  test("renders the root and the slashless paths", async () => {
    for (const path of ["/", "/about", "/posts/hello", "/docs/a/b", "/about?x=1"]) {
      expect(await fetchView(path)).toBeTypeOf("function");
    }
  });

  /** `//evil.com` would be a protocol-relative Location: another host. */
  test("never redirects a path starting with // to another host", async () => {
    for (const path of ["//evil.com/", "///evil.com/", "//"]) {
      const res = await fetchView(path);
      const location = res instanceof Response ? res.headers.get("Location") : null;
      expect(location?.startsWith("//") ?? false).toBe(false);
    }
  });

  test("leaves a route data request alone", async () => {
    const res = await fetchView("/about/.json");
    expect(res instanceof Response ? res.headers.get("Location") : null).toBeNull();
  });
});
