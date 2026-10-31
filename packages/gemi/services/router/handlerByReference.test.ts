import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { Controller } from "../../http/Controller";
import { HttpRequest } from "../../http/HttpRequest";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A handler passed by reference gets the request, as an inline one does
 * (#1110). Inline handlers in a routes file are rewritten at build time to
 * `(req = new HttpRequest()) => ...`; a handler declared elsewhere and passed
 * by name is not, and was called with nothing, so its `req` was `undefined`.
 *
 * This file is not under `http/routes/`, so nothing here is rewritten: every
 * handler below is what a by-reference handler looks like at run time.
 */

process.env.SECRET ??= "handler-by-reference-test-secret";

// A `function` declaration has a prototype, which `isConstructor` (the
// controller check) also matched: it was `new`ed as a controller.
async function showUser(req: HttpRequest<{}, { id: string }>) {
  return { id: req.params.id, q: req.search.get("q") ?? null };
}

const createUser = async (req: HttpRequest<{ name: string }, {}>) => {
  const input = await req.input();
  return { name: input.get("name") };
};

function streamAsset(req: HttpRequest<{}, { name: string }>) {
  return new Blob([`asset:${req.params.name}`], { type: "text/plain" });
}

function downloadReport(req: HttpRequest<{}, { id: string }>) {
  return new Response(`report:${req.params.id}`, { headers: { "Content-Type": "text/plain" } });
}

function viewData(req: HttpRequest<{}, { slug: string }>) {
  return { slug: req.params.slug };
}

function viewFile(req: HttpRequest<{}, { id: string }>) {
  return new File([`view-file:${req.params.id}`], "f.txt", { type: "text/plain" });
}

// What the build makes of an inline `(req: TaggedRequest) => ...`: a default
// that is a request subclass. It has to keep its default, not be handed a
// plain `HttpRequest`.
class TaggedRequest extends HttpRequest<{}, {}> {
  tag = "tagged";
}

class UserController extends Controller {
  show(req: HttpRequest<{}, { id: string }>) {
    return { controller: true, id: req.params.id };
  }
}

class RootApiRouter extends ApiRouter {
  routes = {
    "/users/:id": this.get(showUser),
    "/users": this.post(createUser),
    "/assets/:name": this.stream(streamAsset),
    "/reports/:id": this.file(downloadReport),
    "/controller/:id": this.get(UserController, "show"),
    "/inline/:id": this.get((req = new HttpRequest<{}, { id: string }>()) => ({
      inline: req.params.id,
    })),
    "/tagged": this.get((req = new TaggedRequest()) => ({ tag: req.tag })),
    "/no-params": this.get(() => ({ ok: true })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/posts/:slug": this.view("Post", viewData),
    "/view-files/:id": this.file(viewFile),
  };
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

const fetchApp = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://gemi.dev${path}`, init)) as Promise<Response>;

describe("api handlers passed by reference receive the request", () => {
  test("this.get(fn) with a function declaration: params and search", async () => {
    const res = await fetchApp("/api/users/7?q=hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "7", q: "hello" });
  });

  test("this.post(fn): the body", async () => {
    const res = await fetchApp("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Ada" });
  });

  test("this.stream(fn)", async () => {
    const res = await fetchApp("/api/assets/logo");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:logo");
  });

  test("this.file(fn)", async () => {
    const res = await fetchApp("/api/reports/42");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("report:42");
  });

  test("a controller method declared with a parameter", async () => {
    const res = await fetchApp("/api/controller/3");
    expect(await res.json()).toEqual({ controller: true, id: "3" });
  });
});

describe("inline handlers are unchanged", () => {
  test("a rewritten inline handler builds its own request", async () => {
    const res = await fetchApp("/api/inline/5");
    expect(await res.json()).toEqual({ inline: "5" });
  });

  test("a request subclass default is kept, not replaced", async () => {
    const res = await fetchApp("/api/tagged");
    expect(await res.json()).toEqual({ tag: "tagged" });
  });

  test("a handler with no parameters", async () => {
    const res = await fetchApp("/api/no-params");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("view handlers passed by reference receive the request", () => {
  test("this.view(path, fn)", async () => {
    const res = await fetchApp("/posts/hello-world.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"slug":"hello-world"');
  });

  test("this.file(fn) on a view router", async () => {
    const res = await fetchApp("/view-files/9");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("view-file:9");
  });
});
