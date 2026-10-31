import { createElement } from "react";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { App } from "../app/App";
import { createRoot } from "../client/createRoot";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { Kernel } from "../kernel";
import { createDevFetch } from "./devFetch";

/**
 * #1088, end to end: a real Vite in middleware mode, given the hosts the app
 * allows exactly as `httpDev` gives them, in front of an app with
 * `custom.fallback` (which serves every host). Vite's host check runs before
 * the app, so it alone decides which hosts reach the source Vite serves.
 */

class Api extends ApiRouter {
  routes = { "/ping": this.get(() => ({ ok: true })) };
}

class DevKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: class extends ViewRouter {} },
      domains: {
        root: "gemi.dev",
        groups: [{ subdomain: ":tenant" }],
        custom: {
          group: ":tenant",
          resolve: (host: string) => (host === "app.acme.test" ? { tenant: "acme" } : null),
          fallback: {},
        },
        devHosts: ["app.acme.test", ".shop.test"],
      },
    },
  };
}

let vite: ViteDevServer;
let devFetch: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.SECRET ??= "test-secret";
  const app = new App({ kernel: DevKernel });
  vite = await createServer({
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, ws: false, allowedHosts: app.devAllowedHosts() },
  });
  devFetch = createDevFetch(app, (req, next) => next(req), vite);
});

afterAll(async () => {
  await vite?.close();
});

// `Bun.serve` hands the handler the `Host` the client sent; a plain `Request`
// carries none, so set it as a browser would.
const get = (host: string, path: string) =>
  devFetch(new Request(`http://${host}${path}`, { headers: { host } }));

describe("the dev server's Host check with custom domains", () => {
  test.each(["evil.example", "app.acme.com", "gemi.dev.evil.example"])(
    "refuses %s, which only the fallback would serve",
    async (host) => {
      expect((await get(`${host}:5173`, "/@vite/client")).status).toBe(403);
      expect((await get(`${host}:5173`, "/api/ping")).status).toBe(403);
    },
  );

  test.each(["gemi.dev", "acme.gemi.dev", "app.acme.test", "shop.test", "eu.shop.test", "localhost", "acme.localhost", "127.0.0.1"])(
    "answers %s",
    async (host) => {
      expect((await get(`${host}:5173`, "/@vite/client")).status).toBe(200);
      expect((await get(`${host}:5173`, "/api/ping")).status).toBe(200);
    },
  );
});
