import { describe, test, expect } from "vitest";
import { downgradePublicCacheControl } from "./downgradePublicCacheControl";

function downgrade(cacheControl?: string) {
  const headers = new Headers();
  if (cacheControl !== undefined) {
    headers.set("Cache-Control", cacheControl);
  }
  downgradePublicCacheControl(headers);
  return headers.get("Cache-Control");
}

describe("downgradePublicCacheControl()", () => {
  test("swaps `public` for `private` and keeps the rest of the header", () => {
    // What the saas-starter's `cache:public,12840,must-revalidate` produces.
    expect(downgrade("public, max-age=12840, must-revalidate")).toBe(
      "private, max-age=12840, must-revalidate",
    );
  });

  test("drops `s-maxage`, which only shared caches honour", () => {
    expect(downgrade("public, max-age=60, s-maxage=3600")).toBe("private, max-age=60");
  });

  test("adds `private` when no scope was stated", () => {
    expect(downgrade("max-age=60")).toBe("private, max-age=60");
  });

  test("leaves an already-private header's scope alone", () => {
    expect(downgrade("private, max-age=0, must-revalidate")).toBe(
      "private, max-age=0, must-revalidate",
    );
  });

  test("does not invent a header where there was none", () => {
    expect(downgrade()).toBe(null);
  });

  test("is case-insensitive about the directive", () => {
    expect(downgrade("PUBLIC, max-age=60")).toBe("private, max-age=60");
  });
});
