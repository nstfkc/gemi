import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";

/**
 * A view loader receives path parameters decoded once after matching, as an
 * API handler does (#1306, #1322). `/notes/a%2Fb` matches `/notes/:id` with one
 * segment, and the loader and the hydrated page both see the ID `a/b`.
 */

process.env.SECRET ??= "view-params-test-secret";

const seen: { route: string; params: Record<string, string> }[] = [];

class RootApiRouter extends ApiRouter {
  routes = {
    "/notes/:id": this.get((req) => ({ id: req.params.id })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/notes/:id": this.view("Note", (req: any) => {
      seen.push({ route: "/notes/:id", params: { ...req.params } });
      return { Note: { id: req.params.id } };
    }),
    "/notes/:id/edit": this.view("EditNote", (req: any) => {
      seen.push({ route: "/notes/:id/edit", params: { ...req.params } });
      return { EditNote: {} };
    }),
    "/files/:src*": this.view("Asset", (req: any) => {
      seen.push({ route: "/files/:src*", params: { ...req.params } });
      return { Asset: {} };
    }),
  };
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: createRoot(() => createElement("div")), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: AppKernel });

const renderParams = {
  getStyles: async () => [],
  viewImportMap: {},
  bootstrapModules: [],
  loaders: "{}",
  cssManifest: {},
  ogMap: {},
};

async function page(path: string) {
  const render = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(typeof render).toBe("function");
  return (await (render as any)(renderParams)) as Response;
}

async function navigate(path: string) {
  const res = await app.fetch(new Request(`http://gemi.dev${path}`));
  expect(res).toBeInstanceOf(Response);
  return res as Response;
}

beforeEach(() => {
  seen.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const cases: [string, string][] = [
  ["/notes/42", "42"],
  ["/notes/a%2Fb", "a/b"],
  ["/notes/%252F", "%2F"],
  ["/notes/100%25", "100%"],
];

describe("view route parameters", () => {
  test.each(cases)("a page load of %s gives the loader %j", async (path, id) => {
    const res = await page(path);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ route: "/notes/:id", params: { id } }]);
    // What the client router hydrates `useParams()` from.
    expect(await res.text()).toContain(JSON.stringify({ id }).slice(1, -1));
  });

  test.each(cases)("a client navigation to %s gives the loader %j", async (path, id) => {
    const res = await navigate(`${path}.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is404).toBe(false);
    expect(seen).toEqual([{ route: "/notes/:id", params: { id } }]);
  });

  test("the loader and the API handler see the same ID", async () => {
    await page("/notes/a%2Fb");
    const api = (await app.fetch(new Request("http://gemi.dev/api/notes/a%2Fb"))) as Response;
    expect(await api.json()).toEqual({ id: seen[0].params.id });
  });

  test("an encoded slash does not reach a deeper route", async () => {
    await page("/notes/a%2Fedit");
    expect(seen).toEqual([{ route: "/notes/:id", params: { id: "a/edit" } }]);
  });

  test("a splat gives the same value for both spellings", async () => {
    await page("/files/a%2Fb/c");
    await page("/files/a/b/c");
    expect(seen).toEqual([
      { route: "/files/:src*", params: { src: "a/b/c" } },
      { route: "/files/:src*", params: { src: "a/b/c" } },
    ]);
  });

  test("a malformed escape is a 404 page load that runs no loader", async () => {
    const res = await page("/notes/%E0%A4%A");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('"is404":true');
    expect(seen).toEqual([]);
  });

  test("a malformed escape is a 404 client navigation that runs no loader", async () => {
    const res = await navigate("/notes/%E0%A4%A.json");
    expect(res.status).toBe(200);
    expect((await res.json()).is404).toBe(true);
    expect(seen).toEqual([]);
  });
});
