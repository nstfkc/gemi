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

/**
 * A fetch that rejects on abort, the way the real one does. A mock that
 * ignores `signal` cannot show what `cancel()` leaves behind, because the
 * rejection is what reaches `trigger`'s `catch`.
 */
function fetchStub(...responses: Array<Response | "hang">) {
  let call = 0;
  return vi.fn((_url: string, init: { signal: AbortSignal }) => {
    const next = responses[call++] ?? "hang";
    // A signal that is already aborted rejects before anything is sent, which
    // is the whole of what a reused, spent controller does to a request.
    if (init.signal.aborted) return Promise.reject(aborted());
    if (next !== "hang") return Promise.resolve(next);
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(aborted()));
    });
  });
}

const aborted = () => new DOMException("The operation was aborted.", "AbortError");

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

  /**
   * `cancel()` aborts the request, which rejects the fetch and lands in
   * `trigger`'s `catch`. Reported as an error it would put a `DOMException` in
   * `error` — no `kind`, so `<Form>` renders nothing from it — and call
   * `onError` for something the user asked for.
   */
  test("a cancelled submit is not a failed one", async () => {
    const onError = vi.fn();
    const onCanceled = vi.fn();
    vi.stubGlobal("fetch", fetchStub(respond(422, { error: validationError }), "hang"));

    const { result } = renderHook(() =>
      useMutation(
        "POST" as never,
        "/agents" as never,
        {} as never,
        {
          onError,
          onCanceled,
        } as never,
      ),
    );

    await act(() => result.current.trigger({} as never));
    expect(result.current.error).toEqual(validationError);
    onError.mockClear();

    await act(async () => {
      result.current.trigger({} as never);
    });
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(onCanceled).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  /**
   * `cancel` is rebuilt every render, so a copy taken while the error was on
   * screen closes over that error. Restoring state from that closure puts the
   * old message back after the next submit has already cleared it.
   */
  test("a cancel held from an earlier render does not restore its error", async () => {
    vi.stubGlobal("fetch", fetchStub(respond(422, { error: validationError }), "hang"));

    const { result } = renderHook(() => useMutation("POST" as never, "/agents" as never));

    await act(() => result.current.trigger({} as never));
    expect(result.current.error).toEqual(validationError);
    const staleCancel = result.current.cancel;

    await act(async () => {
      result.current.trigger({} as never);
    });
    expect(result.current.error).toBeNull();

    await act(async () => {
      staleCancel();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  /**
   * Nothing tied a response to the request that asked for it, so the slower
   * of two submits wrote last and won. The corrected submit succeeds, and
   * then the first submit's validation error lands on top of it — #581's
   * symptom again, reached by interleaving rather than by waiting.
   */
  test("a superseded request does not write over the submit that replaced it", async () => {
    let failFirst!: (response: Response) => void;
    let finishSecond!: (response: Response) => void;
    const onError = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((r) => (failFirst = r)))
      .mockReturnValueOnce(new Promise<Response>((r) => (finishSecond = r)));
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(() =>
      useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
    );

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.trigger({} as never);
    });
    act(() => {
      second = result.current.trigger({} as never);
    });

    // The second submit lands first and succeeds.
    await act(async () => {
      finishSecond(respond(200, { ok: true }));
      await second;
    });
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.error).toBeNull();

    // The first submit's rejection arrives late and must be ignored.
    await act(async () => {
      failFirst(respond(422, { error: validationError }));
      await first;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ ok: true });
    expect(onError).not.toHaveBeenCalled();
  });

  /**
   * `cancel()` used to swap the controller through `setState`, so the
   * replacement only existed after a render. A cancel and a resubmit in one
   * tick — a "start over" button — reused the aborted signal, and the new
   * request died on the spot without reporting anything.
   */
  test("a submit right after a cancel, in the same tick, still goes out", async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal("fetch", fetchStub("hang", respond(200, { ok: true })));

    const { result } = renderHook(() =>
      useMutation("POST" as never, "/agents" as never, {} as never, { onSuccess } as never),
    );

    await act(async () => {
      result.current.trigger({} as never);
    });

    let resubmit!: Promise<unknown>;
    await act(async () => {
      result.current.cancel();
      resubmit = result.current.trigger({} as never);
      await resubmit;
    });

    expect(await resubmit).toEqual({ ok: true });
    expect(result.current.data).toEqual({ ok: true });
    expect(result.current.loading).toBe(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  /**
   * `onError` is typed `(error: MutationError) => void`, and the state is set
   * from `data.error`. Handing the callback the whole `{ error: ... }`
   * envelope left it with nothing to branch on.
   */
  test("onError is given the error, not the envelope around it", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", fetchStub(respond(422, { error: validationError })));

    const { result } = renderHook(() =>
      useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
    );

    await act(() => result.current.trigger({} as never));

    expect(onError).toHaveBeenCalledWith(validationError);
    expect(result.current.error).toEqual(validationError);
  });

  /**
   * The pending state keeps `data` on purpose. A rejected submit did not
   * replace the last result either, so blanking it made `<Form>`'s
   * `MutationContext.result` disappear on a validation failure.
   */
  test("a rejected submit leaves the last result in place", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub(respond(200, { id: 1 }), respond(422, { error: validationError })),
    );

    const { result } = renderHook(() => useMutation("POST" as never, "/agents" as never));

    await act(() => result.current.trigger({} as never));
    expect(result.current.data).toEqual({ id: 1 });

    await act(() => result.current.trigger({} as never));
    expect(result.current.error).toEqual(validationError);
    expect(result.current.data).toEqual({ id: 1 });
  });

  /**
   * The config is a `Partial<Config<T>>`, and the framework's own `useSignIn`
   * and `useSignOut` name only `onSuccess`. Every callback the caller leaves
   * out still has to be there to be called.
   */
  describe("a config that names only some callbacks", () => {
    test("a success is a success, not a TypeError reported through onError", async () => {
      const onError = vi.fn();
      vi.stubGlobal("fetch", fetchStub(respond(200, { id: 1 })));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      await act(() => result.current.trigger({} as never));

      expect(result.current.data).toEqual({ id: 1 });
      expect(result.current.error).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    });

    test("cancel works without an onCanceled to call", async () => {
      const onSuccess = vi.fn();
      vi.stubGlobal("fetch", fetchStub("hang"));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onSuccess } as never),
      );

      await act(async () => {
        result.current.trigger({} as never);
      });
      expect(() => act(() => result.current.cancel())).not.toThrow();
      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });
});
