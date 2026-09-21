import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
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
    "/files/api": this.get(() => ({ route: "/files/api" })),
  };
}

class AppKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: {
        root: createRoot(() => createElement("div")),
        rootRouter: class extends ViewRouter {},
      },
    },
  };
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
    expect(await res.json()).toEqual({ error: { message: "Not found" } });
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

  test("an api route whose own path contains /api still matches", async () => {
    const res = await app.fetch(new Request("http://gemi.dev/api/files/api"));

    expect(await res.json()).toEqual({ route: "/files/api" });
  });
});

describe("ApiRouteDispatcher.getRouteHandlerAndParams", () => {
  const dispatcher = () => new ApiRouteDispatcher({ rootRouter: RootApiRouter });

  test("strips only the leading /api", () => {
    const match = (pathname: string) =>
      dispatcher().getRouteHandlerAndParams(new Request(`http://gemi.dev${pathname}`));

    expect(match("/api").path).toBeUndefined();
    expect(match("/api/").path).toBe("/");
    expect(match("/api/users/1")).toEqual({ path: "/users/:id", params: { id: "1" } });
    expect(match("/api/files/api").path).toBe("/files/api");
    // A route path handed to the dispatcher directly is matched as it is,
    // not with an `/api` cut out of its middle.
    expect(match("/files/api").path).toBe("/files/api");
  });
});
