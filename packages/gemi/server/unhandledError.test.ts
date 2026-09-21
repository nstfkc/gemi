import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { unhandledErrorResponse } from "./unhandledError";

// A stack frame as V8/JSC print one: `at fn (/abs/path.ts:1:2)` or `fn@/abs/path`.
const STACK_FRAME = /\bat .+:\d+:\d+|@\/.+:\d+/;

describe("unhandledErrorResponse (production)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const pathname of ["/dashboard", "/api/orders"]) {
    test(`${pathname}: the body carries neither the message nor a stack frame`, async () => {
      const err = new Error("secret detail");
      const res = unhandledErrorResponse(err, pathname);
      const body = await res.text();

      expect(res.status).toBe(500);
      expect(body).not.toContain("secret detail");
      expect(body).not.toMatch(STACK_FRAME);
      expect(body).not.toContain(err.stack!.split("\n")[1]!.trim());
    });

    test(`${pathname}: onException and console.error receive the original error`, () => {
      const err = new Error("secret detail");
      const onException = vi.fn();
      unhandledErrorResponse(err, pathname, onException);

      expect(onException).toHaveBeenCalledTimes(1);
      expect(onException).toHaveBeenCalledWith(err);
      expect(console.error).toHaveBeenCalledWith(err);
    });
  }

  test("a page answers with HTML", () => {
    const res = unhandledErrorResponse(new Error("x"), "/dashboard");
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  test("/api answers with a generic JSON error", async () => {
    const res = unhandledErrorResponse(new Error("x"), "/api/orders");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
  });

  test("a throwing onException still yields the generic 500", async () => {
    const res = unhandledErrorResponse(new Error("secret detail"), "/api/orders", () => {
      throw new Error("reporter down");
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });

  test("a thrown non-Error is handled the same way", async () => {
    const res = unhandledErrorResponse("secret detail", "/dashboard");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });
});
