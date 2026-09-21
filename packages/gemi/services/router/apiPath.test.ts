import { describe, expect, test } from "vitest";

import { apiPath, isApiPath } from "./apiPath";

describe("isApiPath", () => {
  test("is /api itself and anything under /api/", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/")).toBe(true);
    expect(isApiPath("/api/users/1")).toBe(true);
  });

  test("is not a path that only starts with the letters", () => {
    for (const pathname of ["/apidocs", "/apis", "/api-keys", "/apiary", "/", "/files/api"]) {
      expect(isApiPath(pathname), pathname).toBe(false);
    }
  });
});

describe("apiPath", () => {
  test("strips exactly the leading /api", () => {
    expect(apiPath("/api")).toBe("");
    expect(apiPath("/api/")).toBe("/");
    expect(apiPath("/api/users/1")).toBe("/users/1");
    expect(apiPath("/api/files/api")).toBe("/files/api");
  });

  test("leaves a pathname outside /api alone, including one with /api inside it", () => {
    expect(apiPath("/files/api")).toBe("/files/api");
    expect(apiPath("/apidocs")).toBe("/apidocs");
  });
});
