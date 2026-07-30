import { describe, expect, test } from "vitest";

import { routeDataUrl } from "./routeDataUrl";

describe("routeDataUrl", () => {
  test("appends .json to the pathname", () => {
    expect(routeDataUrl({ pathname: "/posts" })).toBe("/posts.json");
  });

  test("keeps the search string", () => {
    expect(routeDataUrl({ pathname: "/posts", search: "?page=2" })).toBe(
      "/posts.json?page=2",
    );
  });

  test("prefixes the locale segment", () => {
    expect(routeDataUrl({ pathname: "/posts", localeSegment: "/tr-TR" })).toBe(
      "/tr-TR/posts.json",
    );
  });

  test("drops the root pathname behind a locale segment", () => {
    expect(routeDataUrl({ pathname: "/", localeSegment: "/tr-TR" })).toBe(
      "/tr-TR.json",
    );
  });

  test("keeps the root pathname on the default locale", () => {
    expect(routeDataUrl({ pathname: "/" })).toBe("/.json");
  });
});
