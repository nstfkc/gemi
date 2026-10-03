/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useEmailCode } from "./useEmailCode";

// `/auth/me` is only refreshed after a sign-in; nothing here needs its cache.
vi.mock("../useQuery", () => ({
  useFrameworkQuery: () => ({ mutate: vi.fn() }),
}));

const invalidCode = {
  kind: "validation_error",
  messages: { code: ["invalid_code"] },
};
const rateLimit = { kind: "rate_limit", message: "Too many requests" };

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

/** Answers by path, one response per call, in order. */
function stubFetch(routes: Record<string, Response[]>) {
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
    const next = routes[path]?.shift();
    if (!next) throw new Error(`No response queued for ${path}`);
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useEmailCode's error (#724)", () => {
  test("a failed request after a failed verify reports the request's error", async () => {
    stubFetch({
      "/auth/email-code/verify": [respond(422, { error: invalidCode })],
      "/auth/email-code": [respond(429, { error: rateLimit })],
    });
    const { result } = renderHook(() => useEmailCode());

    await act(() => result.current.verify("a@b.co", "000000"));
    expect(result.current.error).toMatchObject({ kind: "validation_error" });

    await act(() => result.current.request("a@b.co"));
    expect(result.current.error).toMatchObject({ kind: "rate_limit", status: 429 });
    expect(result.current.requestError).toMatchObject({ kind: "rate_limit" });
    expect(result.current.verifyError).toMatchObject({ kind: "validation_error" });
  });

  test("a successful request clears a stale verify error", async () => {
    stubFetch({
      "/auth/email-code/verify": [respond(422, { error: invalidCode })],
      "/auth/email-code": [respond(200, { ok: true })],
    });
    const { result } = renderHook(() => useEmailCode());

    await act(() => result.current.verify("a@b.co", "000000"));
    expect(result.current.error).not.toBeNull();

    await act(() => result.current.request("a@b.co"));
    expect(result.current.error).toBeNull();
  });

  test("a failed verify after a failed request reports the verify's error", async () => {
    stubFetch({
      "/auth/email-code": [respond(429, { error: rateLimit })],
      "/auth/email-code/verify": [respond(422, { error: invalidCode })],
    });
    const { result } = renderHook(() => useEmailCode());

    await act(() => result.current.request("a@b.co"));
    expect(result.current.error).toMatchObject({ kind: "rate_limit" });

    await act(() => result.current.verify("a@b.co", "000000"));
    expect(result.current.error).toMatchObject({ kind: "validation_error" });
  });

  test("is null before any call", () => {
    stubFetch({});
    const { result } = renderHook(() => useEmailCode());

    expect(result.current.error).toBeNull();
  });
});
