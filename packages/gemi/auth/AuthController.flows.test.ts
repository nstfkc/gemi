import { describe, expect, test } from "vitest";
import { createElement } from "react";

import { App } from "../app/App";
import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import { createRoot } from "../client/createRoot";
import { Kernel } from "../kernel";
import { authConfigDefaults, type AuthConfig } from "./config";

/**
 * `auth.password` and `auth.magicLink` switch off gemi's built-in password and
 * magic-link/PIN routes, for an app that signs in only with email codes or
 * OAuth (#879). A switched-off route answers 404 before it reads the body, so
 * neither a validation error nor a database lookup says the route is there.
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

const NOT_FOUND = { error: { kind: "not_found", message: "Not found", status: 404 } };

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

function post(app: App, path: string, body: unknown = { email: 42 }) {
  return app.fetch(
    new Request(`http://gemi.dev/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("auth.password: false", () => {
  const app = appWith({ password: false });

  for (const path of PASSWORD_ROUTES) {
    test(`POST /auth${path} answers 404`, async () => {
      const res = await post(app, path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  }
});

describe("auth.magicLink: false", () => {
  const app = appWith({ magicLink: false });

  for (const path of MAGIC_LINK_ROUTES) {
    test(`POST /auth${path} answers 404`, async () => {
      const res = await post(app, path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    });
  }

  test("leaves the password routes on", async () => {
    // A malformed sign-in reaches the request's validation.
    const signIn = await post(app, "/sign-in", {});
    expect(signIn.status).toBe(400);

    const verify = await post(app, "/verify-email", {});
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ email: null });
  });
});

describe("by default", () => {
  const app = appWith({});

  test("the password routes are served", async () => {
    const signIn = await post(app, "/sign-in", {});
    expect(signIn.status).toBe(400);

    const verify = await post(app, "/verify-email", {});
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ email: null });
  });

  test("both switches default to on", () => {
    const defaults = authConfigDefaults();
    expect(defaults.password).toBe(true);
    expect(defaults.magicLink).toBe(true);
  });
});

describe("a switch that is not a boolean", () => {
  test.each([
    ["password", "false"],
    ["magicLink", 0],
    ["password", null],
  ] as const)("auth.%s = %j fails at boot", (name, value) => {
    expect(() => authConfigDefaults({ [name]: value } as AuthConfig)).toThrow(
      `auth.${name} must be true or false`,
    );
  });
});

test("a non-boolean switch in app config fails the boot", async () => {
  const app = appWith({ password: "false" } as unknown as AuthConfig);

  await expect(app.waitForBoot()).rejects.toThrow("auth.password must be true or false");
});
