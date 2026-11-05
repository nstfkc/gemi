import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import type { HttpRequest } from "../http/HttpRequest";
import { authConfigDefaults, authSwitchOn, checkAuthFlowSwitches, type AuthConfig } from "./config";
import { authViewRequirements } from "./routes";

/**
 * Per-request flow switches (#1135): `password`, `magicLink` and
 * `emailCode.enabled` may be functions of the request, for an app that serves
 * several hosts from one process. Off for a request, a route answers the 404
 * a `false` switch answers, before the body is read.
 */

const PASSWORD_ROUTES = [
  "/sign-in",
  "/sign-in-v2",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/change-password",
  "/verify-email",
];
const MAGIC_LINK_ROUTES = ["/magic-link", "/sign-in-with-pin", "/sign-in-with-pin-v2"];
const EMAIL_CODE_ROUTES = ["/email-code", "/email-code/verify"];

const NOT_FOUND = { error: { kind: "not_found", message: "Not found", status: 404 } };

const APP_HOST = "app.example.com";
const TENANT_HOST = "tenant.example.com";

const host = (req: HttpRequest<any, any>) => new URL(req.rawRequest.url).host;

function appWith(auth: AuthConfig) {
  class AppKernel extends Kernel {
    config = {
      auth,
      route: {
        api: { rootRouter: class extends ApiRouter {} },
        view: {
          root: createRoot(() => createElement("div")),
          rootRouter: class extends ViewRouter {},
        },
      },
    };
  }
  return new App({ kernel: AppKernel });
}

function post(app: App, hostname: string, path: string, body: unknown = { email: 42 }) {
  return app.fetch(
    new Request(`http://${hostname}/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const NO_LIMITS = {
  requestLimit: { perEmail: false, perIp: false },
  verifyLimit: { perEmail: false, perIp: false },
} as const;

describe("password as a function of the request", () => {
  const asked: string[] = [];
  const app = appWith({
    password: ({ req }) => {
      asked.push(host(req));
      return host(req) === TENANT_HOST;
    },
  });

  for (const path of PASSWORD_ROUTES) {
    test(`POST /auth${path} answers 404 where it is off`, async () => {
      const res = await post(app, APP_HOST, path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  }

  test("the routes are served where it is on", async () => {
    const signIn = await post(app, TENANT_HOST, "/sign-in", {});
    expect(signIn.status).toBe(400);

    const verify = await post(app, TENANT_HOST, "/verify-email", {});
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ email: null });
  });

  test("is handed the request", async () => {
    asked.length = 0;
    await post(app, TENANT_HOST, "/verify-email", {});
    expect(asked).toEqual([TENANT_HOST]);
  });
});

describe("an async switch", () => {
  const app = appWith({
    magicLink: async ({ req }) => host(req) === TENANT_HOST,
    emailCode: { ...NO_LIMITS },
  });

  for (const path of MAGIC_LINK_ROUTES) {
    test(`POST /auth${path} answers 404 where it resolves false`, async () => {
      const res = await post(app, APP_HOST, path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  }

  test("is served where it resolves true", async () => {
    const res = await post(app, TENANT_HOST, "/magic-link", { email: 42 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: null });
  });
});

describe("emailCode.enabled as a function of the request", () => {
  const app = appWith({
    emailCode: { ...NO_LIMITS, enabled: ({ req }) => host(req) === APP_HOST },
  });

  for (const path of EMAIL_CODE_ROUTES) {
    test(`POST /auth${path} answers 404 where it is off`, async () => {
      const res = await post(app, TENANT_HOST, path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  }

  test("is served where it is on", async () => {
    // A malformed address reaches the route's validation.
    const res = await post(app, APP_HOST, "/email-code", { email: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("a switch that answers something other than true", () => {
  const app = appWith({ password: (() => "yes") as unknown as AuthConfig["password"] });

  test("is off", async () => {
    const res = await post(app, TENANT_HOST, "/sign-in", {});
    expect(res.status).toBe(404);
  });
});

describe("authSwitchOn", () => {
  const req = {} as HttpRequest<any, any>;

  test.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])("%j is %j", async (value, expected) => {
    expect(await authSwitchOn(value, req)).toBe(expected);
  });

  test("a function is asked with the request", async () => {
    let seen: unknown = null;
    expect(
      await authSwitchOn(({ req: given }) => {
        seen = given;
        return true;
      }, req),
    ).toBe(true);
    expect(seen).toBe(req);
  });

  test("a throw is not swallowed into on or off", async () => {
    await expect(
      authSwitchOn(() => {
        throw new Error("tenant lookup failed");
      }, req),
    ).rejects.toThrow("tenant lookup failed");
  });
});

describe("checkAuthFlowSwitches", () => {
  test("accepts functions", () => {
    const on = () => true;
    expect(() =>
      checkAuthFlowSwitches({ password: on, magicLink: on, verifyEmail: on, emailCode: { enabled: on } }),
    ).not.toThrow();
    expect(() => authConfigDefaults({ password: on })).not.toThrow();
  });

  test.each([
    ["verifyEmail", { verifyEmail: "false" }],
    ["emailCode.enabled", { emailCode: { enabled: "true" } }],
    ["password", { password: 1 }],
  ])("refuses a non-boolean, non-function auth.%s", (name, config) => {
    expect(() => checkAuthFlowSwitches(config as unknown as AuthConfig)).toThrow(
      `auth.${name} must be true, false or a function of the request`,
    );
  });
});

describe("authViewRequirements", () => {
  test("a function emailCode.enabled may be on, so the magic-link page needs its view", () => {
    const views = authViewRequirements({
      magicLink: false,
      emailCode: { enabled: () => false },
    }).map((r) => r.view);
    expect(views).toContain("auth/MagicLinkSignIn");
  });

  test("a function magicLink may be on too", () => {
    const views = authViewRequirements({ magicLink: () => false }).map((r) => r.view);
    expect(views).toContain("auth/MagicLinkSignIn");
  });

  test("both statically off still need no view", () => {
    expect(authViewRequirements({ magicLink: false, emailCode: { enabled: false } })).toEqual([]);
  });
});
