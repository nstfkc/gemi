import { describe, expect, test } from "vitest";

import { routeHref } from "./routeHref";

/**
 * The one place a route's path, search and hash become an href, shared by
 * `useNavigate` and `Link`. The root route reaches it as an empty path
 * (`applyParams` drops the trailing slash), and joining that with the search
 * used to drop the `?` too: `/` with `a=1` became `a=1`, which the browser
 * resolved against the current URL (#1257).
 */
describe("routeHref", () => {
  test("keeps the ? when the root route has a search", () => {
    expect(routeHref("", "a=1")).toBe("/?a=1");
    expect(routeHref("/", "a=1")).toBe("/?a=1");
  });

  test("keeps the root path in front of a hash", () => {
    expect(routeHref("", "", "#x")).toBe("/#x");
    expect(routeHref("", "a=1", "#x")).toBe("/?a=1#x");
  });

  test("the bare root is /", () => {
    expect(routeHref("", "")).toBe("/");
  });

  test("other paths are unchanged", () => {
    expect(routeHref("/users/7", "")).toBe("/users/7");
    expect(routeHref("/users/7", "tab=posts")).toBe("/users/7?tab=posts");
    expect(routeHref("/users/7", "tab=posts", "#bio")).toBe(
      "/users/7?tab=posts#bio",
    );
    expect(routeHref("/de", "a=1")).toBe("/de?a=1");
  });
});
