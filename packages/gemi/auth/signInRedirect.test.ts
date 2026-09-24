import { describe, expect, test, vi } from "vitest";
import { HttpRequest } from "../http/HttpRequest";

const config = { signInPath: "/auth/sign-in" };

vi.mock("../foundation/app", () => ({
  app: (token: { token?: string }) =>
    token?.token === "translator" ? { supportedLocales: ["en", "de"] } : { config },
}));

const { signInLocation, intendedPathOf } = await import("./signInRedirect");

const view = (url: string) => new HttpRequest(new Request(url), {}, "view");

/** `signInLocation` with `signInPath` set for the duration of one call. */
function withSignInPath<T>(path: string, fn: () => T): T {
  const previous = config.signInPath;
  config.signInPath = path;
  try {
    return fn();
  } finally {
    config.signInPath = previous;
  }
}

describe("signInLocation", () => {
  test("carries the page that was asked for", () => {
    expect(signInLocation(view("http://app.example/invoices?page=2"))).toBe(
      "/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2",
    );
  });

  test("does not send the sign-in page back to itself", () => {
    expect(signInLocation(view("http://app.example/auth/sign-in"))).toBe("/auth/sign-in");
  });

  /** `/x` and `/x/` are the same page, and the guard has to see that. */
  test("the loop guard sees through a trailing slash, either side", () => {
    expect(signInLocation(view("http://app.example/auth/sign-in/"))).toBe("/auth/sign-in");
    expect(
      withSignInPath("/auth/sign-in/", () =>
        signInLocation(view("http://app.example/auth/sign-in")),
      ),
    ).toBe("/auth/sign-in/");
  });

  /**
   * A protected page is often reached with a single-use token — an invite, a
   * magic link, a password reset. Handing that to a third-party sign-in origin
   * puts it in that origin's logs and `Referer`.
   */
  test("keeps the query string off an absolute sign-in URL", () => {
    expect(
      withSignInPath("https://sso.example/login", () =>
        signInLocation(view("http://app.example/accept?invite=SECRET")),
      ),
    ).toBe("https://sso.example/login?redirect=%2Faccept");

    // Same origin, so the query string is the app's own and stays.
    expect(signInLocation(view("http://app.example/accept?invite=SECRET"))).toBe(
      "/auth/sign-in?redirect=%2Faccept%3Finvite%3DSECRET",
    );
  });

  /**
   * The value lands in a `Location` and in the client's `location.replace`.
   * `"auth:https://sso.example/login"` truncates to a bare `https` — the alias
   * parser splits arguments on the colon — which would send signed-out users
   * to `/https` with their intended URL in tow.
   */
  test.each([
    ["a bare scheme, as the route alias form truncates to", "https"],
    ["a relative path", "auth/sign-in"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,x"],
  ])("refuses %s as a sign-in path", (_, path) => {
    expect(() => signInLocation(view("http://app.example/invoices"), path)).toThrow(
      /must be a path like/,
    );
  });

  test("an empty override means the configured path, not an empty one", () => {
    expect(signInLocation(view("http://app.example/invoices"), "")).toBe(
      "/auth/sign-in?redirect=%2Finvoices",
    );
    expect(() => withSignInPath("", () => signInLocation(view("http://app.example/x")))).toThrow(
      /must be a path like/,
    );
  });

  test("accepts a path and an http(s) URL", () => {
    expect(() => signInLocation(view("http://app.example/x"), "/other/sign-in")).not.toThrow();
    expect(() =>
      signInLocation(view("http://app.example/x"), "https://sso.example/login"),
    ).not.toThrow();
  });

  test("an API request has no page to return to", () => {
    expect(
      signInLocation(new HttpRequest(new Request("http://app.example/api/x"), {}, "api")),
    ).toBe("/auth/sign-in");
    expect(signInLocation(undefined)).toBe("/auth/sign-in");
  });
});

describe("intendedPathOf", () => {
  test("drops the data-request suffix and the locale segment", () => {
    expect(intendedPathOf(view("http://app.example/en/invoices.json?page=2"))).toBe(
      "/invoices?page=2",
    );
    expect(intendedPathOf(view("http://app.example/de/invoices.og"))).toBe("/invoices");
  });

  test("keeps the query only when asked to", () => {
    expect(intendedPathOf(view("http://app.example/invoices?page=2"), false)).toBe("/invoices");
  });
});
