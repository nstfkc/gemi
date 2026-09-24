import { describe, expect, test } from "vitest";
import { isExternalRedirect, safeRedirectPath } from "./intendedUrl";
import { applyParams } from "./applyParams";

describe("safeRedirectPath", () => {
  test("keeps a path on this origin, query and hash included", () => {
    expect(safeRedirectPath("/invoices")).toBe("/invoices");
    expect(safeRedirectPath("/invoices?page=2#row-4")).toBe("/invoices?page=2#row-4");
  });

  test.each([
    ["an absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash the browser reads as a slash", "/\\evil.example"],
    ["a tab the browser strips", "/\t/evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a relative path", "invoices"],
    ["an empty string", ""],
    ["a repeated parameter", ["/a", "/b"]],
    ["nothing", null],
  ])("falls back on %s", (_, value) => {
    expect(safeRedirectPath(value, "/dashboard")).toBe("/dashboard");
  });

  /**
   * The `//` guard reads the input, but `new URL` resolves `.`/`..` segments
   * afterwards — and resolving them can *produce* a leading `//`, which a
   * browser reads as protocol-relative. A crafted link to the app's own
   * sign-in page then lands the victim on another origin after they sign in.
   */
  test.each([
    ["a dot-dot segment that composes into //", "/..//evil.example"],
    ["a dot segment that composes into //", "/.//evil.example"],
    ["a deeper path that composes into //", "/x/..//evil.example"],
    ["a percent-encoded dot-dot, which the parser decodes first", "/%2e%2e//evil.example"],
    ["several of them", "/..//..//evil.example"],
  ])("falls back on %s", (_, value) => {
    expect(safeRedirectPath(value, "/dashboard")).toBe("/dashboard");
  });

  test("keeps a path whose segments only look like dots", () => {
    expect(safeRedirectPath("/...//evil.example")).toBe("/...//evil.example");
    expect(safeRedirectPath("/legit/../ok")).toBe("/ok");
  });

  /**
   * `applyParams` reads `:x` as a route parameter, so a colon left raw in the
   * path throws in development and navigates to `/undefined` in production —
   * from nothing worse than `?redirect=/:x` in a link.
   */
  test("encodes a colon in the path, not only in the query", () => {
    expect(safeRedirectPath("/:evil/x")).toBe("/%3Aevil/x");
    expect(safeRedirectPath("/a:b/c")).toBe("/a%3Ab/c");
    for (const value of ["/:evil/x", "/a:b/c", "/javascript:alert(1)"]) {
      const path = safeRedirectPath(value);
      expect(applyParams(path, {})).toBe(path);
    }
  });

  test("survives applyParams, which push and Redirect.to both run", () => {
    const path = safeRedirectPath("/search?next=https://x.example&t=10:30");
    expect(applyParams(path, {})).toBe(path);
    expect(new URL(path, "http://h").searchParams.get("next")).toBe("https://x.example");
    expect(new URL(path, "http://h").searchParams.get("t")).toBe("10:30");
  });
});

/**
 * The result decides whether a `Redirect` directive goes to
 * `window.location.replace` or to the router. `location.replace` with a
 * `javascript:` URL runs it in the current document, so an app that passes a
 * user-influenced value to `Redirect.external` would be handing out
 * same-origin script execution.
 */
describe("isExternalRedirect", () => {
  test.each([
    "https://other.example/x",
    "http://other.example/x",
    "HTTPS://other.example/x",
    "//other.example/x",
  ])("leaves the page for %s", (path) => {
    expect(isExternalRedirect(path)).toBe(true);
  });

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://other.example/x",
    "file:///etc/passwd",
    "https:/other.example",
    "https:other.example",
    "/dashboard",
    "/a:b",
    "",
    null,
  ])("stays in the router for %s", (path) => {
    expect(isExternalRedirect(path)).toBe(false);
  });
});
