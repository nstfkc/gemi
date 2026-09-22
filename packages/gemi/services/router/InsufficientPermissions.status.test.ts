import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";

import { App } from "../../app/App";
import { AuthManager } from "../../auth/AuthManager";
import { UserProvider } from "../../auth/UserProvider";
import type { FindSessionArgs, SessionWithUser } from "../../auth/types";
import { Auth } from "../../facades/Auth";
import { ApiRouter } from "../../http/ApiRouter";
import { InsufficientPermissionsError } from "../../http/errors";
import { ViewRouter } from "../../http/ViewRouter";
import { Kernel } from "../../kernel";
import { isSystemScope } from "../../orm/context";
import { applyPolicies, currentUser, policyContext } from "../../orm/policy";
import { ServiceProvider } from "../../support/ServiceProvider";

/**
 * What `Auth.guard()` answers, through a whole `App`, on each of the three
 * shapes of request it can refuse (#542): an api route, a `.json` view
 * navigation and a full page load. The first two answer from `payload.api`, so
 * `apiStatus` moves both; the page answers from `payload.view`.
 */

process.env.SECRET ??= "insufficient-permissions-status-test-secret";

class StubUsers extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    return args.token === "tok-bob"
      ? ({ token: args.token, user: { id: 2, name: "bob" } } as any)
      : null;
  }
}

class StubAuthProvider extends ServiceProvider {
  register() {
    this.app.singleton(AuthManager, () => new AuthManager({}, new StubUsers()));
  }
}

const refuse = () => Auth.guard(() => false);

class RootApiRouter extends ApiRouter {
  routes = {
    "/admin": this.get(async () => {
      await refuse();
      return {};
    }),
    // A predicate that reads a model the policy refuses, rather than returning
    // false: the denial propagates out of `guard` as itself.
    "/admin-by-policy": this.get(async () => {
      await Auth.guard(() => {
        applyPolicies(
          [{ before: () => false }],
          policyContext("Order", "findMany", currentUser(), isSystemScope()),
          {},
        );
        return true;
      });
      return {};
    }),
  };
}

class RootViewRouter extends ViewRouter {
  routes = {
    "/admin": this.view("Admin", async () => {
      await refuse();
      return { Admin: {} };
    }),
  };
}

class AppKernel extends Kernel {
  protected providers = [StubAuthProvider];
  config = {
    route: {
      api: { rootRouter: RootApiRouter },
      view: { root: () => createElement("div"), rootRouter: RootViewRouter },
    },
  };
}

const app = new App({ kernel: AppKernel });
const bob = { Cookie: "access_token=tok-bob" };

async function status(path: string) {
  const result: unknown = await app.fetch(new Request(`http://gemi.dev${path}`, { headers: bob }));
  expect(result).toBeInstanceOf(Response);
  return (result as Response).status;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  InsufficientPermissionsError.apiStatus = 403;
  vi.restoreAllMocks();
});

describe("a signed-in user Auth.guard refuses", () => {
  test("answers 403 on an api route, a view navigation and a page load", async () => {
    expect(await status("/api/admin")).toBe(403);
    expect(await status("/admin.json")).toBe(403);
    expect(await status("/admin")).toBe(403);
  });

  test("apiStatus = 401 restores 401 on the api route and the view navigation only", async () => {
    InsufficientPermissionsError.apiStatus = 401;

    expect(await status("/api/admin")).toBe(401);
    // Answered from `payload.api`, as it was in 0.62.
    expect(await status("/admin.json")).toBe(401);
    // Never 401 before: it fell to the view dispatcher's 400 default.
    expect(await status("/admin")).toBe(403);
  });

  test("a policy denial inside the predicate answers the policy's 403, whatever apiStatus says", async () => {
    InsufficientPermissionsError.apiStatus = 401;

    const res = await app.fetch(
      new Request("http://gemi.dev/api/admin-by-policy", { headers: bob }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: "Forbidden" } });
  });
});
