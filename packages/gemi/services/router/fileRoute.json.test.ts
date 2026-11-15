import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { createFlatViewRoutes } from "./createFlatViewRoutes";
import { isViewDataPath, isViewOgPath } from "./matchViewRoute";

/**
 * A `this.file(...)` route declared at a path ending in `.json` (or `.og`) is
 * that file, not a view's data URL (#1275). Every other `.json` path is still
 * the view data of the route it names without the suffix.
 */

process.env.SECRET ??= "file-route-json-test-secret";

class TestViewRouter extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About", () => ({ title: "About us" })),
    "/doc": this.view("Doc", () => ({ title: "The doc page" })),
    "/doc.json": this.file(() => Response.json({ file: "doc" })),
    "/.well-known/poppy.json": this.file(() => Response.json({ ok: true })),
    "/card.og": this.file(() => new Response("png", { headers: { "Content-Type": "image/png" } })),
    "/page": this.view("Page", () => ({})).static(),
    "/a.json/b": this.view("Nested", () => ({ title: "nested" })),
  };
}

class TestApiRouter extends ApiRouter {
  routes = {};
}

class TestKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: TestApiRouter },
      view: { root: () => createElement("div"), rootRouter: TestViewRouter },
    },
  };
}

const app = new App({ kernel: TestKernel });

async function get(path: string): Promise<unknown> {
  return await app.fetch(new Request(`http://gemi.dev${path}`));
}

async function getResponse(path: string): Promise<Response> {
  const out = await get(path);
  expect(out).toBeInstanceOf(Response);
  return out as Response;
}

describe("a file route at a .json path", () => {
  test("answers its handler's response", async () => {
    const res = await getResponse("/.well-known/poppy.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("next to a view at the same path without .json: the .json is the file, the path the page", async () => {
    const file = await getResponse("/doc.json");
    expect(file.status).toBe(200);
    expect(await file.json()).toEqual({ file: "doc" });

    // The page is a document: the render function, not a Response.
    expect(await get("/doc")).toBeTypeOf("function");
  });

  test("a file route at a .og path answers its handler's response", async () => {
    const res = await getResponse("/card.og");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("png");
  });
});

describe("a view's .json data", () => {
  test("a view route still answers its .json with the view data", async () => {
    const res = await getResponse("/about.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("About us");
  });

  test("a static view still answers its .json with 404", async () => {
    const res = await getResponse("/page.json");
    expect(res.status).toBe(404);
  });

  test("only the .json suffix is cut, not the first .json in the path", async () => {
    const res = await getResponse("/a.json/b.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nested");
  });
});

describe("isViewDataPath", () => {
  const routes = createFlatViewRoutes(new TestViewRouter().routes as any);

  test("is false for a file route's literal .json path and for a path without .json", () => {
    expect(isViewDataPath(routes, "/doc.json")).toBe(false);
    expect(isViewDataPath(routes, "/.well-known/poppy.json")).toBe(false);
    expect(isViewDataPath(routes, "/about")).toBe(false);
  });

  test("is true for any other .json path", () => {
    expect(isViewDataPath(routes, "/about.json")).toBe(true);
    expect(isViewDataPath(routes, "/nowhere.json")).toBe(true);
  });

  test("isViewOgPath reads a file route at a .og path as that file", () => {
    expect(isViewOgPath(routes, "/card.og")).toBe(false);
    expect(isViewOgPath(routes, "/about.og")).toBe(true);
  });
});
