import { describe, expect, test } from "vitest";

import { apiUrl, matchApiUrl } from "./apiUrl";

describe("apiUrl", () => {
  test("fills params under /api", () => {
    expect(apiUrl("/pages/:pageId/files/:fileId", { pageId: "p1", fileId: "f1" })).toBe(
      "/api/pages/p1/files/f1",
    );
    expect(apiUrl("/designer-files/:fileId", { fileId: 7 })).toBe("/api/designer-files/7");
  });

  test("a path without params", () => {
    expect(apiUrl("/auth/me")).toBe("/api/auth/me");
    expect(apiUrl("/")).toBe("/api");
  });

  test("encodes each value so it stays in its segment", () => {
    expect(apiUrl("/form/:formId", { formId: "a b/c?d#é" })).toBe(
      "/api/form/a%20b%2Fc%3Fd%23%C3%A9",
    );
  });

  test("a value with a dot", () => {
    expect(apiUrl("/script-assets/:publicId/:file", { publicId: "s1", file: "abc.png" })).toBe(
      "/api/script-assets/s1/abc.png",
    );
  });

  test("an optional param left out drops its segment", () => {
    expect(apiUrl("/posts/:id?", {})).toBe("/api/posts");
    expect(apiUrl("/posts/:id?/edit", {})).toBe("/api/posts/edit");
    expect(apiUrl("/posts/:id?", { id: "1" })).toBe("/api/posts/1");
  });

  test("a wildcard keeps its slashes and encodes each segment", () => {
    expect(apiUrl("/files/:path*", { path: "a b/c" })).toBe("/api/files/a%20b/c");
    expect(apiUrl("/files/:path*", { path: ["a/b", "c"] })).toBe("/api/files/a%2Fb/c");
  });

  test("a required param left out throws", () => {
    expect(() => apiUrl("/form/:formId", {})).toThrow("`/form/:formId` needs a value for :formId.");
    expect(() => apiUrl("/form/:formId", { formId: "" })).toThrow("needs a value");
  });

  test("ignores Object.prototype keys", () => {
    expect(() => apiUrl("/x/:constructor", {})).toThrow("needs a value");
  });
});

describe("matchApiUrl", () => {
  test("answers the params of a matching path, decoded", () => {
    expect(matchApiUrl("/pages/:pageId/files/:fileId", "/api/pages/p1/files/f1")).toEqual({
      pageId: "p1",
      fileId: "f1",
    });
    expect(matchApiUrl("/form/:formId", "/api/form/a%20b%2Fc")).toEqual({ formId: "a b/c" });
  });

  test("round-trips apiUrl", () => {
    const params = { pageId: "p 1/é", fileId: "f?1" };
    const url = apiUrl("/pages/:pageId/files/:fileId", params);
    expect(matchApiUrl("/pages/:pageId/files/:fileId", url)).toEqual(params);
  });

  test("absolute URLs, queries and hashes", () => {
    expect(
      matchApiUrl("/designer-files/:fileId", "https://example.com/api/designer-files/f1?w=200#x"),
    ).toEqual({
      fileId: "f1",
    });
  });

  test("null when it is not the route's URL", () => {
    expect(matchApiUrl("/pages/:pageId/files/:fileId", "/api/pages/p1/images/1.png")).toBeNull();
    expect(matchApiUrl("/pages/:pageId/files/:fileId", "/pages/p1/files/f1")).toBeNull();
    expect(matchApiUrl("/designer-files/:fileId", "https://example.com/a.png")).toBeNull();
    expect(matchApiUrl("/designer-files/:fileId", "/api/designer-files/%E0%A4%A")).toBeNull();
  });

  test("a path without params matches to {}", () => {
    expect(matchApiUrl("/auth/me", "/api/auth/me")).toEqual({});
  });
});
