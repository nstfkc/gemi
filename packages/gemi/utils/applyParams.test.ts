import { describe, expect, test } from "vitest";

import { applyParams } from "./applyParams";
import { decodePathParams } from "./pathParams";

/**
 * Route params arrive decoded (#1306, #1322), so filling a template has to
 * encode them again: otherwise `a/b` would split into two segments and the
 * URL would name another route.
 */
describe("applyParams()", () => {
  test.each([
    ["42", "/notes/42/edit"],
    ["a/b", "/notes/a%2Fb/edit"],
    ["100%", "/notes/100%25/edit"],
    ["a b", "/notes/a%20b/edit"],
    ["%2F", "/notes/%252F/edit"],
    ["a?b#c", "/notes/a%3Fb%23c/edit"],
  ])("encodes %j into its segment", (id, url) => {
    expect(applyParams("/notes/:id/edit", { id })).toBe(url);
  });

  test("a wildcard keeps its slashes and encodes each segment", () => {
    expect(applyParams("/files/:src*", { src: "a/b c/100%" })).toBe("/files/a/b%20c/100%25");
  });

  test("numbers and optional params", () => {
    expect(applyParams("/posts/:id/:tab?", { id: 7 })).toBe("/posts/7");
    expect(applyParams("/posts/:id/:tab?", { id: 7, tab: "x y" })).toBe("/posts/7/x%20y");
  });

  test("round-trips through decodePathParams", () => {
    for (const id of ["a/b", "100%", "%2F", "a b", "ü"]) {
      const url = applyParams("/notes/:id", { id });
      const segment = url.slice("/notes/".length);
      expect(decodePathParams({ id: segment })).toEqual({ id });
    }
  });
});
