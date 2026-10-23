import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { createRoot } from "../../client/createRoot";
import { ApiRouter } from "../../http/ApiRouter";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { ApiRouteDispatcher, isDevelopmentServer } from "./ApiRouteDispatcher";

/**
 * #1030: the route table (`/__gemi__/debug/*`) and the live log file
 * (`/__gemi__/services/logs/live`) are the developer's, mounted by the dev
 * server only. Everywhere else, a 404, as for any path no route matches.
 */

class RootApiRouter extends ApiRouter {
  routes = {
    "/orders": this.get(() => ({ ok: true })),
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

const devOnly = [
  "/__gemi__/debug/api-routes",
  "/__gemi__/debug/view-routes",
  "/__gemi__/services/logs/live",
];

function pathsMounted(nodeEnv: string | undefined) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  return Object.keys(new ApiRouteDispatcher({ rootRouter: RootApiRouter }).flatRoutes);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("debug endpoints are mounted in development only (#1030)", () => {
  test("the dev server mounts them", () => {
    const paths = pathsMounted("development");

    expect(paths).toEqual(expect.arrayContaining(devOnly));
  });

  test.each([["production"], ["test"], ["staging"], [undefined]])(
    "NODE_ENV=%s does not",
    (nodeEnv) => {
      const paths = pathsMounted(nodeEnv);

      for (const path of devOnly) {
        expect(paths).not.toContain(path);
      }
      // The framework routes apps rely on stay.
      expect(paths).toContain("/__gemi__/services/i18n/set-locale/:locale");
      expect(paths).toContain("/__gemi__/services/image/resize");
      expect(paths).toContain("/orders");
    },
  );

  test("isDevelopmentServer follows NODE_ENV=development exactly", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevelopmentServer()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevelopmentServer()).toBe(false);
    vi.stubEnv("NODE_ENV", "");
    expect(isDevelopmentServer()).toBe(false);
  });

  test("in production a request for them is a 404", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new App({ kernel: AppKernel });

    for (const path of devOnly) {
      const res = await app.fetch(new Request(`http://gemi.dev/api${path}`));
      expect([path, res.status]).toEqual([path, 404]);
    }
    const ok = await app.fetch(new Request("http://gemi.dev/api/orders"));
    expect(ok.status).toBe(200);
  });

  test("in development the route table is served", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new App({ kernel: AppKernel });

    const res = await app.fetch(new Request("http://gemi.dev/api/__gemi__/debug/api-routes"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/orders", method: "GET" })]),
    );
  });
});
