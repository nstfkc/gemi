import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { HttpRequest } from "../http/HttpRequest";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";

process.env.SECRET ??= "test-secret";

const SHOP_PROXY_SECRET = "shop-proxy-secret-long-enough";
const FDID = "8a2b1c3d-0000-4e5f-9a8b-123456789abc";

/**
 * `route.domains.trustProxy` as a list (#1013), end to end through
 * `App.fetch`: shop traffic comes buyer -> Cloudflare Worker -> Azure Front
 * Door -> app, panel traffic user -> Front Door -> app.
 */

class Api extends ApiRouter {
  routes = {
    "/who": this.get((req = new HttpRequest()) => ({
      host: req.domain?.host ?? null,
      group: req.domain?.group ?? null,
      ip: req.rawRequest.headers.get("x-forwarded-for"),
    })),
    "/upstream": this.proxy("http://upstream.internal/echo"),
  };
}

class Views extends ViewRouter {
  routes = {};
}

class ChainKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: Views },
      domains: {
        root: "panel.example",
        trustProxy: [
          {
            hostHeader: "x-original-host",
            clientIpHeader: "x-client-ip",
            secret: { header: "x-proxy-secret", value: SHOP_PROXY_SECRET },
          },
          { clientIpHeader: "x-azure-clientip", secret: { header: "x-azure-fdid", value: FDID } },
        ],
        groups: [{ subdomain: ":shop" }],
        custom: { group: ":shop", resolve: () => null },
      },
    },
  };
}

const app = new App({ kernel: ChainKernel });

async function fetchJson(req: Request) {
  app.applyTrustedClientIp(req);
  const res = (await app.fetch(req)) as Response;
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

/** What Front Door hands the app, having come through the Worker. */
const viaWorker = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://web.azurecontainerapps.example${path}`, {
    headers: {
      "x-original-host": "acme.panel.example",
      "x-client-ip": "203.0.113.9",
      "x-proxy-secret": SHOP_PROXY_SECRET,
      "x-azure-clientip": "104.28.0.1",
      "x-azure-fdid": FDID,
      ...headers,
    },
  });

/** What Front Door hands the app for the panel. */
const viaFrontDoor = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://panel.example${path}`, {
    headers: { "x-azure-clientip": "198.51.100.7", "x-azure-fdid": FDID, ...headers },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trustProxy list through App.fetch", () => {
  test("shop traffic: the Worker's host and the buyer's address", async () => {
    expect(await fetchJson(viaWorker("/api/who"))).toEqual({
      status: 200,
      body: { host: "acme.panel.example", group: ":shop", ip: "203.0.113.9" },
    });
  });

  test("panel traffic: its own host and Front Door's address for the user", async () => {
    expect(await fetchJson(viaFrontDoor("/api/who", { "x-original-host": "acme.panel.example" })))
      .toEqual({ status: 200, body: { host: "panel.example", group: "", ip: "198.51.100.7" } });
  });

  test("a proxy() route forwards neither proxy's secret", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("ok", { status: 200 }));

    for (const request of [viaWorker("/api/upstream"), viaFrontDoor("/api/upstream")]) {
      const res = (await app.fetch(request)) as Response;
      expect(res.status).toBe(200);
    }
    // Including a wrong secret: it is withheld whether or not it matched.
    await app.fetch(viaFrontDoor("/api/upstream", { "x-proxy-secret": "a-guess-at-the-secret" }));

    expect(upstream).toHaveBeenCalledTimes(3);
    for (const call of upstream.mock.calls) {
      const headers = new Headers(call[1]?.headers as HeadersInit);
      expect(headers.get("x-proxy-secret")).toBeNull();
      expect(headers.get("x-azure-fdid")).toBeNull();
    }
  });
});
