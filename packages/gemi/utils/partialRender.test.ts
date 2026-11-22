import { describe, test, expect } from "vitest";

import { initialRenderedRoute } from "./partialRender";

describe("initialRenderedRoute()", () => {
  test("keeps the path the router is on", () => {
    expect(initialRenderedRoute({ pathname: "/app/acme/chat", search: "" })).toBe("/app/acme/chat");
  });

  test("keeps the search string", () => {
    expect(initialRenderedRoute({ pathname: "/app/acme/chat", search: "?tab=2" })).toBe(
      "/app/acme/chat?tab=2",
    );
  });

  test("falls back to the root", () => {
    expect(initialRenderedRoute({})).toBe("/");
    expect(initialRenderedRoute({ pathname: "" })).toBe("/");
  });
});

describe("initialRenderedRoute() is not rebuilt from decoded params (#1322)", () => {
  test.each([
    "/notes/a%2Fb",
    "/notes/a%2fb",
    "/notes/%252F",
    "/u/john@x.com",
    "/u/c++",
    // A `:` here is part of the value, not a param.
    "/u/a:b",
  ])("%s goes out as it came in", (pathname) => {
    expect(initialRenderedRoute({ pathname, search: "" })).toBe(pathname);
  });
});
