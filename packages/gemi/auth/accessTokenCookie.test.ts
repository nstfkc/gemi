import { afterEach, describe, expect, test } from "vitest";

import { AuthManager } from "./AuthManager";
import { Application } from "../foundation/Application";
import { DomainRouter } from "../services/router/DomainRouter";

/**
 * `accessTokenCookieOptions` is on the path of every sign-in, so what it
 * reaches for has to exist wherever a sign-in does. It consults `DomainRouter`
 * for the proxy configuration — and `DomainRouter` is bound by
 * `RouteServiceProvider`, which an app's own database-backed auth test has no
 * reason to register. Resolving it unconditionally turned every such test into
 * `BindingResolutionError: Target [router.domains] is not bound`.
 */

const previous = Application.getInstance();

afterEach(() => {
  if (previous) {
    Application.setInstance(previous);
  }
});

function withContainer(bind: (app: Application) => void) {
  const application = new Application();
  bind(application);
  Application.setInstance(application);
  return new AuthManager();
}

const request = (url: string, headers: Record<string, string> = {}) =>
  ({ rawRequest: new Request(url, { headers }) }) as never;

describe("accessTokenCookieOptions without a router", () => {
  test("writes the cookie from the request alone when `DomainRouter` is unbound", () => {
    const auth = withContainer(() => {});

    expect(
      auth.accessTokenCookieOptions(request("https://example.com/"), new Date(0)),
    ).toMatchObject({ secure: true, httpOnly: true, domain: undefined });
    expect(
      auth.accessTokenCookieOptions(request("http://example.com/"), new Date(0)),
    ).toMatchObject({ secure: false });
  });

  test("consults the router for the forwarded scheme when there is one", () => {
    const auth = withContainer((application) => {
      application.instance(
        DomainRouter,
        new DomainRouter({ api: {}, view: {} } as never, {
          api: {} as never,
          view: {} as never,
          domains: { root: "example.com" },
        }),
      );
    });

    // Plain http to the app, https to the client: only the router knows.
    expect(
      auth.accessTokenCookieOptions(
        request("http://example.com/", { "x-forwarded-proto": "https" }),
        new Date(0),
      ),
    ).toMatchObject({ secure: true });
  });
});
