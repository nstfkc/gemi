/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useMutation } from "./useMutation";

const validationError = {
  kind: "validation_error",
  messages: { prompt: ["Too long"] },
};

// What `error` holds for it: the body's field, with the status it came with.
const reportedValidationError = { ...validationError, status: 422 };

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
    expect(result.current.error).toEqual(reportedValidationError);

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
    expect(result.current.error).toEqual(reportedValidationError);
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
    expect(result.current.error).toEqual(reportedValidationError);
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

    expect(onError).toHaveBeenCalledWith(reportedValidationError);
    expect(result.current.error).toEqual(reportedValidationError);
  });

  /**
   * An app's own status, from `HttpResponse.json(data, { status })`. A 2xx
   * other than 200 is a success like any other, and an error body is handed
   * over as gemi's own are: the `error` field when there is one, else the body
   * whole — read as `body.error` it was `undefined`, and `error` then looked
   * like no error at all.
   */
  describe("a route's own status", () => {
    test("a 201 is a success", async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      vi.stubGlobal("fetch", fetchStub(respond(201, { id: 1 })));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, {
          onSuccess,
          onError,
        } as never),
      );

      await act(() => result.current.trigger({} as never));

      expect(onSuccess).toHaveBeenCalledWith({ id: 1 });
      expect(onError).not.toHaveBeenCalled();
      expect(result.current.data).toEqual({ id: 1 });
    });

    test("a 409 with an error field hands over the field", async () => {
      const onError = vi.fn();
      vi.stubGlobal("fetch", fetchStub(respond(409, { error: { message: "Taken" } })));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      await act(() => result.current.trigger({} as never));

      // Given the kind its status stands for, so `<FormError>` shows it.
      const reported = { kind: "form_error", message: "Taken", status: 409 };
      expect(onError).toHaveBeenCalledWith(reported);
      expect(result.current.error).toEqual(reported);
    });

    test("a 409 without an error field hands over the body", async () => {
      const onError = vi.fn();
      const body = { code: "slug_taken", message: "Taken" };
      vi.stubGlobal("fetch", fetchStub(respond(409, body)));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      await act(() => result.current.trigger({} as never));

      const reported = { ...body, kind: "form_error", status: 409 };
      expect(onError).toHaveBeenCalledWith(reported);
      expect(result.current.error).toEqual(reported);
    });

    test("a JSON null body is still an error", async () => {
      const onError = vi.fn();
      vi.stubGlobal("fetch", fetchStub(respond(422, null)));

      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      await act(() => result.current.trigger({} as never));

      const reported = {
        kind: "form_error",
        message: "Request failed with status 422",
        status: 422,
      };
      expect(onError).toHaveBeenCalledWith(reported);
      expect(result.current.error).toEqual(reported);
    });
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
    expect(result.current.error).toEqual(reportedValidationError);
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
  /**
   * Issue #623. `trigger` is typed `Promise<T | undefined>` because it
   * resolves `undefined` whenever there is no result — and it must keep
   * resolving rather than rejecting: `<Form>` and every
   * `onClick={() => trigger()}` call it without a `catch`, so a rejection
   * would surface as an unhandled one. The failure is reported where it
   * always was, through `onError` and `error`.
   */
  describe("what trigger resolves to", () => {
    test("the response body on a 2xx", async () => {
      vi.stubGlobal("fetch", fetchStub(respond(200, { id: 1 })));
      const { result } = renderHook(() => useMutation("POST" as never, "/agents" as never));

      let resolved: unknown;
      await act(async () => {
        resolved = await result.current.trigger({} as never);
      });
      expect(resolved).toEqual({ id: 1 });
    });

    test("undefined, not a rejection, on a non-2xx", async () => {
      const onError = vi.fn();
      vi.stubGlobal("fetch", fetchStub(respond(422, { error: validationError })));
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      let settled!: Promise<unknown>;
      await act(async () => {
        settled = result.current.trigger({} as never);
        await settled.catch(() => {});
      });
      await expect(settled).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(reportedValidationError);
    });

    test("undefined, not a rejection, on a network failure", async () => {
      const onError = vi.fn();
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/agents" as never, {} as never, { onError } as never),
      );

      let settled!: Promise<unknown>;
      await act(async () => {
        settled = result.current.trigger({} as never);
        await settled.catch(() => {});
      });
      await expect(settled).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Issue #719. kyte draws pictures on two nodes at once through one `usePost`;
   * latest-wins dropped the first job's saved page and, worse, its validation
   * error. `concurrency: "parallel"` gives every call its own outcome.
   */
  describe("concurrency", () => {
    /** A fetch whose answers the test releases one by one, in any order. */
    function deferredFetch() {
      const calls: Array<{
        signal: AbortSignal;
        release: (response: Response) => void;
      }> = [];
      const fetch = vi.fn((_url: string, init: { signal: AbortSignal }) => {
        return new Promise<Response>((resolve, reject) => {
          calls.push({ signal: init.signal, release: resolve });
          init.signal.addEventListener("abort", () => reject(aborted()));
        });
      });
      return { fetch, calls };
    }

    const parallel = { concurrency: "parallel" } as never;

    test("two concurrent triggers each resolve and run their own callbacks", async () => {
      const { fetch, calls } = deferredFetch();
      vi.stubGlobal("fetch", fetch);
      const onSuccess = vi.fn();
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, {
          concurrency: "parallel",
          onSuccess,
        } as never),
      );

      const first = vi.fn();
      const second = vi.fn();
      let a!: Promise<unknown>;
      let b!: Promise<unknown>;
      act(() => {
        a = result.current.trigger({ path: "a" } as never, { onSuccess: first });
      });
      act(() => {
        b = result.current.trigger({ path: "b" } as never, { onSuccess: second });
      });
      expect(result.current.loading).toBe(true);
      expect(result.current.pending).toBe(2);

      // The second answers first; neither supersedes the other.
      await act(async () => {
        calls[1]!.release(respond(200, { id: "b" }));
        await b;
      });
      expect(result.current.loading).toBe(true);
      expect(result.current.pending).toBe(1);
      expect(result.current.data).toEqual({ id: "b" });

      await act(async () => {
        calls[0]!.release(respond(200, { id: "a" }));
        await a;
      });
      await expect(a).resolves.toEqual({ id: "a" });
      await expect(b).resolves.toEqual({ id: "b" });
      expect(first).toHaveBeenCalledWith({ id: "a" });
      expect(second).toHaveBeenCalledWith({ id: "b" });
      expect(onSuccess).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(false);
      expect(result.current.pending).toBe(0);
      // The last call to settle.
      expect(result.current.data).toEqual({ id: "a" });
    });

    test("one failing and one succeeding each report their own outcome", async () => {
      const { fetch, calls } = deferredFetch();
      vi.stubGlobal("fetch", fetch);
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, {
          concurrency: "parallel",
          onError,
        } as never),
      );

      const failed = { onSuccess: vi.fn(), onError: vi.fn() };
      const succeeded = { onSuccess: vi.fn(), onError: vi.fn() };
      let a!: Promise<unknown>;
      let b!: Promise<unknown>;
      act(() => {
        a = result.current.trigger({ path: "a" } as never, failed);
        b = result.current.trigger({ path: "b" } as never, succeeded);
      });

      // The failure lands first, then the success: the error is not lost to
      // the newer request, and the success clears the hook-level `error`.
      await act(async () => {
        calls[0]!.release(respond(422, { error: validationError }));
        await a;
      });
      expect(result.current.error).toEqual(reportedValidationError);
      expect(result.current.loading).toBe(true);

      await act(async () => {
        calls[1]!.release(respond(200, { id: "b" }));
        await b;
      });

      await expect(a).resolves.toBeUndefined();
      await expect(b).resolves.toEqual({ id: "b" });
      expect(failed.onError).toHaveBeenCalledWith(reportedValidationError);
      expect(failed.onSuccess).not.toHaveBeenCalled();
      expect(succeeded.onSuccess).toHaveBeenCalledWith({ id: "b" });
      expect(succeeded.onError).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual({ id: "b" });
      expect(result.current.loading).toBe(false);
    });

    test("a parallel failure keeps the last result, and a newer call does not clear it", async () => {
      const { fetch, calls } = deferredFetch();
      vi.stubGlobal("fetch", fetch);
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, parallel),
      );

      let a!: Promise<unknown>;
      act(() => {
        a = result.current.trigger({} as never);
      });
      await act(async () => {
        calls[0]!.release(respond(200, { id: 1 }));
        await a;
      });
      act(() => {
        a = result.current.trigger({} as never);
      });
      await act(async () => {
        calls[1]!.release(respond(422, { error: validationError }));
        await a;
      });
      expect(result.current.data).toEqual({ id: 1 });
      expect(result.current.error).toEqual(reportedValidationError);

      // Another job starting is not news about the failed one.
      act(() => {
        result.current.trigger({} as never);
      });
      expect(result.current.error).toEqual(reportedValidationError);
    });

    /**
     * #693 aborts a `useQuery` fetch nobody reads any more. A mutation is a
     * write the user asked for: a newer one must never abort it.
     */
    test("a newer trigger does not abort the one in flight", async () => {
      const { fetch, calls } = deferredFetch();
      vi.stubGlobal("fetch", fetch);
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, parallel),
      );

      act(() => {
        result.current.trigger({} as never);
        result.current.trigger({} as never);
        result.current.trigger({} as never);
      });
      expect(calls.map((c) => c.signal.aborted)).toEqual([false, false, false]);
      expect(result.current.pending).toBe(3);
    });

    test("cancel() aborts every call in flight, without onError", async () => {
      const { fetch, calls } = deferredFetch();
      vi.stubGlobal("fetch", fetch);
      const onError = vi.fn();
      const onCanceled = vi.fn();
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, {
          concurrency: "parallel",
          onError,
          onCanceled,
        } as never),
      );

      let a!: Promise<unknown>;
      let b!: Promise<unknown>;
      act(() => {
        a = result.current.trigger({} as never);
        b = result.current.trigger({} as never);
      });
      await act(async () => {
        result.current.cancel();
        await Promise.all([a, b]);
      });

      expect(calls.every((c) => c.signal.aborted)).toBe(true);
      await expect(a).resolves.toBeUndefined();
      await expect(b).resolves.toBeUndefined();
      expect(onCanceled).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.pending).toBe(0);
    });

    test("an onError that throws still leaves pending at zero", async () => {
      vi.stubGlobal("fetch", fetchStub(respond(422, { error: validationError })));
      const { result } = renderHook(() =>
        useMutation("POST" as never, "/images" as never, {} as never, {
          concurrency: "parallel",
          onError: (error: unknown) => {
            if ((error as { kind?: string }).kind) throw new Error("boom");
          },
        } as never),
      );

      await act(() => result.current.trigger({} as never));
      expect(result.current.pending).toBe(0);
      expect(result.current.loading).toBe(false);
    });

    describe("the default stays latest-wins", () => {
      test("a superseded call resolves undefined and runs no callbacks, its own included", async () => {
        const { fetch, calls } = deferredFetch();
        vi.stubGlobal("fetch", fetch);
        const onSuccess = vi.fn();
        const onError = vi.fn();
        const { result } = renderHook(() =>
          useMutation("POST" as never, "/images" as never, {} as never, {
            onSuccess,
            onError,
          } as never),
        );

        const older = { onSuccess: vi.fn(), onError: vi.fn() };
        const newer = { onSuccess: vi.fn(), onError: vi.fn() };
        let a!: Promise<unknown>;
        let b!: Promise<unknown>;
        act(() => {
          a = result.current.trigger({} as never, older);
          b = result.current.trigger({} as never, newer);
        });
        // Not aborted either: latest-wins drops the answer, not the request.
        expect(calls[0]!.signal.aborted).toBe(false);
        expect(result.current.pending).toBe(2);

        await act(async () => {
          calls[1]!.release(respond(200, { id: "b" }));
          await b;
        });
        // The newest request has settled, so the hook is no longer loading
        // even though the superseded one is still on the wire.
        expect(result.current.loading).toBe(false);
        expect(result.current.pending).toBe(1);

        await act(async () => {
          calls[0]!.release(respond(422, { error: validationError }));
          await a;
        });

        await expect(a).resolves.toBeUndefined();
        await expect(b).resolves.toEqual({ id: "b" });
        expect(older.onSuccess).not.toHaveBeenCalled();
        expect(older.onError).not.toHaveBeenCalled();
        expect(newer.onSuccess).toHaveBeenCalledWith({ id: "b" });
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual({ id: "b" });
        expect(result.current.loading).toBe(false);
        expect(result.current.pending).toBe(0);
      });
    });
  });
});
