import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { AuthManager } from "../auth/AuthManager";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "./ApiRouter";
import { AuthenticationMiddleware } from "./AuthenticationMiddlware";
import { ViewRouter } from "./ViewRouter";
import { Kernel } from "../kernel";
import { SIGN_IN_HEADER } from "./signInHeader";

process.env.SECRET ??= "test-secret";

/**
 * An `/api` request refused for authentication says where a page would have
 * been sent (#1119), so the web client never hardcodes the sign-in path. No
 * intended URL: an API request is not a page to come back to.
 */

beforeAll(() => {
  vi.spyOn(AuthManager.prototype, "userProvider", "get").mockReturnValue({
    findSession: async () => null,
  } as any);
});

afterAll(() => {
  vi.restoreAllMocks();
});

class RootApiRouter extends ApiRouter {
  routes = {
    "/guarded": this.get(() => ({})).middleware(["auth"]),
    "/admin/stats": this.get(() => ({})).middleware(["auth:/admin/sign-in"]),
    "/open": this.get(() => ({ ok: true })),
  };
}

class RootViewRouter extends ViewRouter {
  routes = { "/": this.view("Home", () => ({})) };
}

const app = new App({
  kernel: class extends Kernel {
    config = {
      middleware: { aliases: { auth: AuthenticationMiddleware } },
      route: {
        api: { rootRouter: RootApiRouter },
        view: { root: createRoot(() => createElement("div")), rootRouter: RootViewRouter },
      },
    };
  },
});

const get = (path: string) => app.fetch(new Request(`http://gemi.dev/api${path}`)) as Promise<Response>;

test("carries the configured sign-in path", async () => {
  const res = await get("/guarded");

  expect(res.status).toBe(401);
  expect(res.headers.get(SIGN_IN_HEADER)).toBe("/auth/sign-in");
  expect(await res.json()).toEqual({
    error: { kind: "authentication", message: "Authentication error", status: 401 },
  });
});

test("carries a route's own sign-in path", async () => {
  const res = await get("/admin/stats");

  expect(res.headers.get(SIGN_IN_HEADER)).toBe("/admin/sign-in");
});

test("is absent on any other answer", async () => {
  expect((await get("/open")).headers.get(SIGN_IN_HEADER)).toBeNull();
});
