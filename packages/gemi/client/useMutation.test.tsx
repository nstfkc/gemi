/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useMutation } from "./useMutation";

const validationError = {
  kind: "validation_error",
  messages: { prompt: ["Too long"] },
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

// Auto-cleanup needs vitest globals, which this repo doesn't enable.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMutation", () => {
  test("a new submit clears the previous error while it is pending", async () => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(422, { error: validationError }))
      .mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMutation("POST" as never, "/agents" as never));

    await act(() => result.current.trigger({} as never));
    expect(result.current.error).toEqual(validationError);

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.trigger({} as never);
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      release(respond(200, { ok: true }));
      await pending;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ ok: true });
  });

  test("cancel does not bring back the previous error", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(422, { error: validationError }))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() => useMutation("POST" as never, "/agents" as never));

    await act(() => result.current.trigger({} as never));
    act(() => {
      result.current.trigger({} as never);
    });
    act(() => result.current.cancel());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
