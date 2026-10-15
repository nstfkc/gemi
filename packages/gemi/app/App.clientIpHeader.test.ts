import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "./App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { HttpRequest } from "../http/HttpRequest";
import { clientIp } from "../http/RateLimitMiddleware";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";

process.env.SECRET ??= "test-secret";

const FDID = "8a2b1c3d-0000-4e5f-9a8b-123456789abc";

/**
 * `GEMI_CLIENT_IP_HEADER` end to end through `App.fetch`, for an app without
 * `route.domains` behind Azure Front Door (#958): `X-Azure-ClientIP` names the
 * client on a request whose `X-Azure-FDID` is the app's profile.
 */

class Api extends ApiRouter {
  routes = {
    "/ip": this.get((req = new HttpRequest()) => ({ ip: clientIp(req) })),
    "/upstream": this.proxy("http://upstream.internal/echo"),
  };
}

class SingleHostKernel extends Kernel {
  config = {
    route: {
      api: { rootRouter: Api },
      view: { root: createRoot(() => createElement("div")), rootRouter: class extends ViewRouter {} },
    },
  };
}

// Read when the router is first made, i.e. on the first request.
const ENV = {
  GEMI_CLIENT_IP_HEADER: "X-Azure-ClientIP",
  GEMI_PROXY_SECRET_HEADER: "X-Azure-FDID",
  GEMI_PROXY_SECRET: FDID,
};
const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
Object.assign(process.env, ENV);
const app = new App({ kernel: SingleHostKernel });

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const request = (path: string, headers: Record<string, string>) =>
  new Request(`http://folio.azurewebsites.net${path}`, { headers });

async function ipOf(headers: Record<string, string>) {
  const res = (await app.fetch(request("/api/ip", headers))) as Response;
  return ((await res.json()) as { ip: string }).ip;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GEMI_CLIENT_IP_HEADER without route.domains", () => {
  test("Front Door's client address is what clientIp (the rate-limit key) reads", async () => {
    expect(
      await ipOf({
        "x-azure-clientip": "203.0.113.9",
        "x-azure-fdid": FDID,
        "x-forwarded-for": "169.254.0.1",
      }),
    ).toBe("203.0.113.9");
  });

  test("a wrong or missing FDID leaves X-Forwarded-For alone", async () => {
    expect(await ipOf({ "x-azure-clientip": "203.0.113.9", "x-forwarded-for": "198.51.100.4" })).toBe(
      "198.51.100.4",
    );
    expect(
      await ipOf({
        "x-azure-clientip": "203.0.113.9",
        "x-azure-fdid": "some-other-front-door-profile",
        "x-forwarded-for": "198.51.100.4",
      }),
    ).toBe("198.51.100.4");
  });

  test("the FDID is not forwarded by a proxy() route", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("ok", { status: 200 }));

    const res = (await app.fetch(
      request("/api/upstream", { "x-azure-clientip": "203.0.113.9", "x-azure-fdid": FDID }),
    )) as Response;

    expect(res.status).toBe(200);
    const headers = new Headers(upstream.mock.calls[0]![1]?.headers as HeadersInit);
    expect(headers.get("x-azure-fdid")).toBeNull();
  });
});
