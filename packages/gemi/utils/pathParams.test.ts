import { describe, expect, test } from "vitest";

import { canonicalPath } from "./pathParams";

describe("canonicalPath()", () => {
  test.each([
    ["/u/john@x.com", "/u/john%40x.com"],
    ["/u/c++", "/u/c%2B%2B"],
    ["/u/a:b", "/u/a%3Ab"],
    ["/u/a,b", "/u/a%2Cb"],
    ["/u/a%2fb", "/u/a%2Fb"],
    ["/u/john@x.com?q=a@b#c@d", "/u/john%40x.com?q=a@b#c@d"],
  ])("%s and %s compare equal", (a, b) => {
    expect(canonicalPath(a)).toBe(canonicalPath(b));
  });

  test.each([
    ["/u/a%2Fb", "/u/a/b"],
    ["/u/%252F", "/u/%2F"],
    ["/u/a?q=@", "/u/a?q=%40"],
  ])("%s and %s stay different", (a, b) => {
    expect(canonicalPath(a)).not.toBe(canonicalPath(b));
  });

  test("keeps a malformed escape, the root and a trailing slash", () => {
    expect(canonicalPath("/u/%E0%A4%A")).toBe("/u/%E0%A4%A");
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("/u/")).toBe("/u/");
  });
});
