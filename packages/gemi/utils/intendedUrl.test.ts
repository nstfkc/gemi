import { describe, expect, test } from "vitest";
import { safeRedirectPath } from "./intendedUrl";
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

  test("survives applyParams, which push and Redirect.to both run", () => {
    const path = safeRedirectPath("/search?next=https://x.example&t=10:30");
    expect(applyParams(path, {})).toBe(path);
    expect(new URL(path, "http://h").searchParams.get("next")).toBe("https://x.example");
    expect(new URL(path, "http://h").searchParams.get("t")).toBe("10:30");
  });
});
