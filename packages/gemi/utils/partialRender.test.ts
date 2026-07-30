import { describe, test, expect } from "vitest";

import { initialRenderedRoute } from "./partialRender";

describe("initialRenderedRoute()", () => {
  test("resolves the route pattern the server matched", () => {
    // What the router holds on the first render — a pattern, not a path.
    expect(
      initialRenderedRoute({
        pathname: "/app/:orgId/chat",
        params: { orgId: "acme" },
        search: "",
      }),
    ).toBe("/app/acme/chat");
  });

  test("keeps an already-resolved path as it is", () => {
    expect(
      initialRenderedRoute({ pathname: "/about", params: {}, search: "" }),
    ).toBe("/about");
  });

  test("keeps the search string", () => {
    expect(
      initialRenderedRoute({
        pathname: "/app/:orgId/chat",
        params: { orgId: "acme" },
        search: "?tab=2",
      }),
    ).toBe("/app/acme/chat?tab=2");
  });

  test("falls back to the root", () => {
    expect(initialRenderedRoute({})).toBe("/");
  });
});
