import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { Storage } from "../facades/Storage";
import { FileSystemDriver } from "../services/file-storage/drivers/FileSystemDriver";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { HttpRequest } from "../http/HttpRequest";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { ApiRouteDispatcher } from "../services/router/ApiRouteDispatcher";
import { ViewRouteDispatcher } from "../services/router/ViewRouteDispatcher";

/**
 * Which dispatcher `App.fetch` hands a pathname to, and the route the api
 * dispatcher then matches it against. `/api` is a path segment, not a string
 * prefix: `/apidocs` is a view, and an api route's own path may contain `/api`.
 */

class RootApiRouter extends ApiRouter {
  routes = {
    "/": this.get(() => ({ route: "/" })),
    "/users/:id": this.get((req = new HttpRequest<{}, { id: string }>()) => ({
      route: "/users/:id",
      id: req.params.id,
    })),
    "/assets/:src*": this.stream((req: HttpRequest<{}, { src: string }>) => Storage.read(req.params.src)),
    "/archive/:rest*": this.get(() => ({})),
    "/optional/:id?": this.get(() => ({})),
    "/files/api": this.get(() => ({ route: "/files/api" })),
  };
}

const route = {
  api: { rootRouter: RootApiRouter },
  view: {
    root: createRoot(() => createElement("div")),
    rootRouter: class extends ViewRouter {},
  },
};

class AppKernel extends Kernel {
  config = { route };
}

const app = new App({ kernel: AppKernel });

let toApi: ReturnType<typeof vi.spyOn>;
let toView: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toApi = vi.spyOn(ApiRouteDispatcher.prototype, "handleApiRequest");
  // The view render itself is not under test; only that the request got here.
  toView = vi
    .spyOn(ViewRouteDispatcher.prototype, "handleViewRequest")
    .mockResolvedValue(new Response("view"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.fetch routes by the /api segment", () => {
  for (const pathname of ["/apidocs", "/apis", "/api-keys", "/apiary"]) {
    test(`${pathname} reaches the view dispatcher`, async () => {
      const res = await app.fetch(new Request(`http://gemi.dev${pathname}`));

      expect(await res.text()).toBe("view");
      expect(toView).toHaveBeenCalledTimes(1);
      expect(toApi).not.toHaveBeenCalled();
    });
  }

  test("/api reaches the api dispatcher, as the path '' that no route has", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api"));

    expect(toApi).toHaveBeenCalledTimes(1);
    expect(toView).not.toHaveBeenCalled();
    // The api dispatcher's own 404, not a view: `""` is not `/`.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { kind: "not_found", message: "Not found", status: 404 } });
  });

  test("/api/ reaches the api dispatcher, as /", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/"));

    expect(toApi).toHaveBeenCalledTimes(1);
    expect(toView).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ route: "/" });
  });

  test("/api/users/1 reaches the api dispatcher, as /users/1", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/users/1"));

    expect(toApi).toHaveBeenCalledTimes(1);
    expect(toView).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ route: "/users/:id", id: "1" });
  });

  test("a stream route serves nested assets and refuses names outside its storage folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "gemi-api-assets-"));
    try {
      const driver = new FileSystemDriver(join(root, "assets"));
      class AssetKernel extends Kernel {
        config = { route, filesystem: { driver } };
      }
      const assetApp = new App({ kernel: AssetKernel });
      const requestAsset = (name: string) =>
        assetApp.fetch(new Request("http://gemi.dev/api/assets/" + encodeURIComponent(name)));

      const name = await driver.put({ name: "nested/..notes.txt", body: new Blob(["notes"]) });
      const valid = await requestAsset(name);
      expect(valid.status).toBe(200);
      expect(await valid.text()).toBe("notes");

      const openFile = vi.spyOn(Bun, "file");
      const refused = await requestAsset("../outside.txt");
      expect(refused.status).toBe(404);
      expect((await refused.json()).error.kind).toBe("not_found");
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A regression guard: the old `replace("/api", "")` cut only the first
  // `/api` too, so this passed before the fix as well.
  test("an api route whose own path contains /api still matches", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/files/api"));

    expect(await res.json()).toEqual({ route: "/files/api" });
  });
});

describe("ApiRouteDispatcher.getRouteHandlerAndParams", () => {
  const dispatcher = () => new ApiRouteDispatcher({ rootRouter: RootApiRouter });

  test("decodes path values once after matching the route", async () => {
    const id = "a/b ?#é %2F";
    const response = await app.fetch(new Request("http://gemi.dev/api/users/" + encodeURIComponent(id)));
    expect(await response.json()).toEqual({ route: "/users/:id", id });

    const match = (path: string) => dispatcher().getRouteHandlerAndParams(new Request("http://gemi.dev" + path));
    expect(match("/api/archive/a%20b/c").params.rest).toBe("a b/c");
    expect(match("/api/archive/a%2Fb/c").params.rest).toBe("a/b/c");
    expect(match("/api/archive/a/b/c").params.rest).toBe("a/b/c");
    expect(match("/api/optional").params.id).toBeUndefined();
  });

  test("a malformed parameter gets the dispatcher's normal 404", async () => {
    const response = await app.fetch(new Request("http://gemi.dev/api/users/%E0%A4%A"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.kind).toBe("not_found");
  });

  test("strips only the leading /api", () => {
    const match = (pathname: string) =>
      dispatcher().getRouteHandlerAndParams(new Request(`http://gemi.dev${pathname}`));

    expect(match("/api").path).toBeUndefined();
    expect(match("/api/").path).toBe("/");
    expect(match("/api/users/1")).toEqual({ path: "/users/:id", params: { id: "1" } });
    // Passes with or without the fix; kept as a guard.
    expect(match("/api/files/api").path).toBe("/files/api");
    // A route path handed to the dispatcher directly is matched as it is,
    // not with an `/api` cut out of its middle.
    expect(match("/files/api").path).toBe("/files/api");
  });
});
