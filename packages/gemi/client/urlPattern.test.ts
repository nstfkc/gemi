import { afterEach, describe, expect, test } from "vitest";
import { loadURLPattern, urlPattern } from "./urlPattern";

/** #1162: `URLPattern` native where it exists, the polyfill on demand elsewhere. */

const native = (globalThis as { URLPattern?: unknown }).URLPattern;
afterEach(() => {
  (globalThis as { URLPattern?: unknown }).URLPattern = native;
});

describe("URLPattern on demand (#1162)", () => {
  test("nothing to load where the runtime has it", () => {
    expect(typeof native).toBe("function");
    expect(loadURLPattern()).toBeUndefined();
    expect(urlPattern("/posts/:id").exec({ pathname: "/posts/7" })?.pathname.groups).toEqual({ id: "7" });
  });

  test("without it, the polyfill is loaded and installed", async () => {
    delete (globalThis as { URLPattern?: unknown }).URLPattern;
    expect(() => urlPattern("/a")).toThrow(/URLPattern is not available/);
    await loadURLPattern();
    expect(typeof (globalThis as { URLPattern?: unknown }).URLPattern).toBe("function");
    expect(urlPattern("/a/:b").test({ pathname: "/a/c" })).toBe(true);
  });
});
