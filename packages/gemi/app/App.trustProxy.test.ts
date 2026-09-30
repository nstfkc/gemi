import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { HttpRequest } from "../http/HttpRequest";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { Query } from "../facades/Prefetch";
import { Url } from "../facades/Url";

process.env.SECRET ??= "test-secret";

const PROXY_SECRET = "proxy-secret-long-enough";

/**
 * `route.domains.trustProxy` with a host header of its own and a shared
 * secret, end to end through `App.fetch` — the setup of an app behind
 * Cloudflare for SaaS in front of Railway, where `Host` and `X-Forwarded-Host`
 * both name the app's own domain and the customer's host only survives in a
 * header the CDN adds.
 */

class Api extends ApiRouter {
  routes = {
    "/who": this.get((req = new HttpRequest()) => ({
      host: req.domain?.host ?? null,
      group: req.domain?.group ?? null,
      params: req.domain?.params ?? null,
      custom: req.domain?.custom ?? null,
    })),
    "/url": this.get(() => ({
      url: (Url as any).forDomain({ subdomain: "admin" }, "/users/:id", { id: 7 }),
    })),
    "/upstream": this.proxy("http://upstream.internal/echo", { "x-added": "yes" }),
  };
}

class Views extends ViewRouter {
  routes = {
    "/whoami": this.view("WhoAmI", async () => ({
      WhoAmI: { answer: await (Query as any).instant("/who") },
    })),
  };
}

class ProxiedKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: Views },
      domains: {
        root: "kyte.app",
        trustProxy: {
          hostHeader: "x-kyte-host",
          secret: { header: "x-kyte-proxy-secret", value: PROXY_SECRET },
        },
        groups: [{ subdomain: "admin" }, { subdomain: ":site" }],
        custom: {
          group: ":site",
          resolve: (host: string) => (host === "acme.com" ? { site: "acme" } : null),
        },
      },
    },
  };
}

const app = new App({ kernel: ProxiedKernel });

/** A request as it reaches the app: addressed to the platform's own domain. */
const origin = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://kyte.up.railway.app${path}`, {
    headers: {
      "x-forwarded-host": "kyte.up.railway.app",
      "x-forwarded-proto": "https",
      ...headers,
    },
  });

/** The same, having come through the CDN for `host`. */
const viaCdn = (path: string, host: string) =>
  origin(path, { "x-kyte-host": host, "x-kyte-proxy-secret": PROXY_SECRET });

async function json(req: Request) {
  const res = (await app.fetch(req)) as Response;
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("behind the CDN, with the secret", () => {
  test("a customer's domain is routed by the CDN's header", async () => {
    expect(await json(viaCdn("/api/who", "acme.com"))).toEqual({
      status: 200,
      body: { host: "acme.com", group: ":site", params: { site: "acme" }, custom: true },
    });
  });

  test("so is a subdomain of the root", async () => {
    expect((await json(viaCdn("/api/who", "acme.kyte.app"))).body).toMatchObject({
      host: "acme.kyte.app",
      group: ":site",
      params: { site: "acme" },
      custom: false,
    });
  });

  test("links are built on the host the client addressed, over https", async () => {
    expect((await json(viaCdn("/api/url", "acme.kyte.app"))).body).toEqual({
      url: "https://admin.kyte.app/users/7",
    });
  });

  test("a server-side query is answered for the same domain", async () => {
    const res = (await app.fetch(viaCdn("/whoami.json", "acme.com"))) as Response;
    const body = JSON.parse(await new Response(res.body).text());
    expect(body.prefetchedData["/who"][""]).toEqual({
      host: "acme.com",
      group: ":site",
      params: { site: "acme" },
      custom: true,
    });
  });
});

describe("around the CDN", () => {
  test("a spoofed host header without the secret is ignored", async () => {
    const spoofed = origin("/api/who", { "x-kyte-host": "acme.com" });
    // `kyte.up.railway.app` is outside the root and not a customer: 404.
    expect(await json(spoofed)).toEqual({ status: 404, body: "Unknown host" });
  });

  test("a wrong secret is the same as none", async () => {
    const spoofed = origin("/api/who", {
      "x-kyte-host": "acme.com",
      "x-kyte-proxy-secret": "not-the-proxy-secret",
    });
    expect((await json(spoofed)).status).toBe(404);
  });

  test("the app's own domains still work when reached directly", async () => {
    const direct = new Request("http://acme.kyte.app/api/who", {
      headers: { "x-kyte-host": "acme.com" },
    });
    expect((await json(direct)).body).toMatchObject({ host: "acme.kyte.app", custom: false });
  });
});

describe("a `proxy()` route", () => {
  test("does not forward the proxy's secret upstream", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("ok", { status: 200 }));

    const res = (await app.fetch(viaCdn("/api/upstream", "acme.kyte.app"))) as Response;

    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const headers = new Headers(upstream.mock.calls[0][1]?.headers as HeadersInit);
    expect(headers.get("x-kyte-proxy-secret")).toBeNull();
    // Nothing else changes about what it forwards.
    expect(headers.get("x-kyte-host")).toBe("acme.kyte.app");
    expect(headers.get("x-added")).toBe("yes");
  });
});
