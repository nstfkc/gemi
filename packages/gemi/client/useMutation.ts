import { useContext, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";
import { useParams } from "./useParams";
import { ClientRouterContext } from "./ClientRouterContext";
import { mutationErrorFromBody, type MutationError } from "./MutationError";

type Methods = {
  POST: {
    [K in keyof RPC as K extends `POST:${infer P}` ? P : never]: RPC[K];
  };
  PUT: {
    [K in keyof RPC as K extends `PUT:${infer P}` ? P : never]: RPC[K];
  };
  PATCH: {
    [K in keyof RPC as K extends `PATCH:${infer P}` ? P : never]: RPC[K];
  };
  DELETE: {
    [K in keyof RPC as K extends `DELETE:${infer P}` ? P : never]: RPC[K];
  };
};

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}?`, value).replace(`:${key}`, value);
  }
  return out;
}

/**
 * How a hook treats a `trigger` that starts while another is in flight.
 *
 * - `"latest"` (the default): the newest request wins. An older request that
 *   settles afterwards is dropped: its callbacks don't run, it writes no state
 *   and its `trigger` resolves `undefined`. Right for forms and edits, where a
 *   newer submit supersedes the older one.
 * - `"parallel"`: every request stands on its own. Each one runs its callbacks
 *   and resolves its own `trigger`, whatever else is in flight (issue #719).
 *
 * Neither mode aborts the older request; only `cancel()` does.
 */
export type MutationConcurrency = "latest" | "parallel";

type Config<T, E = never> = {
  autoInvalidate?: boolean;
  onSuccess: (data: T) => void;
  /**
   * A `MutationError`, or one of the route's typed errors (`E`): the bodies
   * its handler answers with `HttpResponse.error` / `httpError`.
   *
   * Method syntax, so a handler written as `(error: MutationError) => …`
   * before the route had typed errors still compiles.
   */
  onError(error: MutationError | E): void;
  onCanceled?: () => void;
  concurrency?: MutationConcurrency;
};

/**
 * Callbacks for one `trigger` call. They run after the hook's own, and only
 * when the hook's would: in `"latest"` mode a superseded call runs neither.
 */
export type MutationCallConfig<T, E = never> = {
  onSuccess?: (data: T) => void;
  onError?(error: MutationError | E): void;
};

const defaultOptions: Config<any> = {
  autoInvalidate: false,
  onSuccess: () => {},
  onError: (_: MutationError) => {},
  onCanceled: () => {},
};

type Data<
  M extends keyof Methods,
  K extends keyof Methods[M],
> = Methods[M][K] extends ApiRouterHandler<any, infer T, any>
  ? UnwrapPromise<T>
  : never;

type Body<
  M extends keyof Methods,
  K extends keyof Methods[M],
> = Methods[M][K] extends ApiRouterHandler<infer T, any, any> ? T : never;

/**
 * The route's typed errors: what its handler answers with `HttpResponse.error`
 * or `httpError`, as `onError` receives them. `never` when it has none.
 */
type ErrorOf<
  M extends keyof Methods,
  K extends keyof Methods[M],
> = Methods[M][K] extends ApiRouterHandler<any, any, any, infer E> ? E : never;

type ParseParams<T> = UrlParser<`${T & string}`>;

type State<T, E = never> = {
  data: T | null;
  error: MutationError | E | null;
  loading: boolean;
  // Requests on the wire, superseded ones included.
  pending: number;
};

export function useMutation<
  M extends keyof Methods,
  K extends keyof Methods[M],
  T = Data<M, K>,
  U = Body<M, K>,
  E = ErrorOf<M, K>,
>(
  method: M,
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>>, search?: Record<string, string> },
    config?: Partial<Config<T, E>>,
  ]
) {
  const _params = useParams();
  // A write may have moved the data behind any page warmed ahead of a click,
  // and a prefetched payload is committed wholesale — into the query cache too.
  const { clearPrefetchCache } = useContext(ClientRouterContext);
  const [state, setState] = useState<State<T, E>>({
    data: null,
    error: null,
    loading: false,
    pending: 0,
  });

  // A controller per request, held in a ref rather than state. Swapping it
  // through `setState` only took effect on the next render, so a `cancel()`
  // and a `trigger()` in one tick reused the signal `cancel()` had just
  // aborted and the new request never left the ground.
  const abortController = useRef(new AbortController());

  // Only the newest request may write state. Nothing tied a response to the
  // request that asked for it, so two submits in flight resolved in whatever
  // order the network returned them — and a slow first submit's validation
  // error could land after the corrected second one had already succeeded,
  // putting the message back and wiping the result.
  const latestRequest = useRef(0);

  // Every request still on the wire in `"parallel"` mode, so `cancel()` can
  // abort all of them rather than only the newest.
  const inFlight = useRef(new Set<AbortController>());

  const formData = useRef(new FormData());

  // `Partial<Config<T>>` means a caller may name only the callbacks it wants,
  // and the framework's own `useSignIn`/`useSignOut` name only `onSuccess`.
  // Taking the config as given left the rest undefined, so a success called
  // `options.onSuccess(data)` on `undefined` and reported its own `TypeError`
  // through `onError`.
  const [inputs = {}, config] = args ?? [];
  const options: Config<T, E> = { ...defaultOptions, ...config };

  // Resolves `undefined` rather than rejecting whenever there is no result to
  // hand back: a non-2xx response or a network failure (both already reported
  // through `onError` and `error`), a `cancel()`, and a request superseded by a
  // newer `trigger`. It was typed `Promise<T>`, so `const r = await trigger()`
  // read `r.id` off `undefined` with nothing in the types to say it could.
  // Rejecting instead would turn every `onClick={() => trigger()}` — and
  // `<Form>`'s own submit — into an unhandled rejection, so the type changed
  // and the behaviour did not (issue #623).
  //
  // In `"parallel"` mode no call is superseded: each one resolves to its own
  // body and runs its own callbacks, and `data`/`error` hold the outcome of
  // whichever call settled last.
  const parallel = options.concurrency === "parallel";

  async function trigger(
    input?: U,
    call: MutationCallConfig<T, E> = {},
  ): Promise<T | undefined> {
    const controller = new AbortController();
    abortController.current = controller;
    if (parallel) inFlight.current.add(controller);
    const requestId = ++latestRequest.current;
    const isSuperseded = () =>
      !parallel && latestRequest.current !== requestId;

    // The last response's error is about the last submit. Left in place, a
    // corrected resubmit shows the old validation message until it returns.
    // In parallel mode it belongs to another call, which is still the last
    // one to have settled.
    setState((prev) => ({
      data: prev.data,
      error: parallel ? prev.error : null,
      loading: true,
      pending: prev.pending + 1,
    }));
    // One request off the wire. `update` gives the state it leaves; `loading`
    // is `pending > 0` in parallel mode, while in latest mode it follows the
    // newest request alone, as it always has, so a superseded one settling
    // leaves it as it is.
    //
    // A call leaves `pending` once: an `onError` that throws lands in the
    // `catch` and settles the call a second time.
    let left = false;
    const settle = (
      update: (prev: State<T, E>) => Pick<State<T, E>, "data" | "error">,
      superseded = false,
    ) => {
      inFlight.current.delete(controller);
      const leaving = !left;
      left = true;
      setState((prev) => {
        const pending = leaving ? prev.pending - 1 : prev.pending;
        return {
          ...update(prev),
          pending,
          loading: parallel ? pending > 0 : superseded ? prev.loading : false,
        };
      });
    };
    // The accumulator this call sent, so a parallel call settling doesn't
    // empty fields gathered since for the next one.
    const sentFormData = typeof input === "undefined" ? formData.current : null;
    const resetFormData = () => {
      if (!parallel || formData.current === sentFormData) {
        formData.current = new FormData();
      }
    };
    const params =
      "params" in inputs ? { ..._params, ...inputs.params } : _params;
    const search = "search" in inputs ? inputs.search : {};
    const searchParams = new URLSearchParams(search);
    const finalUrl = [applyParams(String(url).replace(`${method}:`, ""), params), searchParams.toString()].filter(Boolean).join("?");

    let body = null;

    const contentType =
      typeof input === "undefined" || input instanceof FormData
        ? {}
        : { "Content-Type": "application/json" };

    if (input instanceof FormData) {
      body = input;
    } else if (typeof input === "undefined") {
      body = formData.current;
    } else if (input) {
      body = JSON.stringify(input);
    }

    try {
      const response = await fetch(`/api${finalUrl}`, {
        method,
        headers: {
          ...contentType,
        },
        ...(body ? { body } : {}),
        signal: controller.signal,
      });

      const data = await response.json();

      // A superseded request has nothing left to say: a newer submit is what
      // the user is waiting on, and its state is the state on screen.
      if (isSuperseded()) {
        settle((prev) => prev, true);
        return;
      }

      resetFormData();

      if (!response.ok) {
        // `data.error` rather than the envelope around it: `onError` is typed
        // `(error: MutationError) => void`, and the envelope has no `kind` to
        // branch on. A body without one — an app's own `HttpResponse.json` —
        // is handed over whole.
        const error = mutationErrorFromBody(data, response.status);

        // `data` is the last result the caller was given, and a rejected
        // submit did not replace it — the same reason the pending state above
        // keeps it.
        settle((prev) => ({ data: prev.data, error }));

        options.onError(error);
        call.onError?.(error);
        return;
      }

      clearPrefetchCache?.();
      options.onSuccess(data);
      call.onSuccess?.(data);

      settle(() => ({ data, error: null }));

      return data as T;
    } catch (error) {
      if (isSuperseded()) {
        settle((prev) => prev, true);
        return;
      }

      resetFormData();
      // `cancel()` aborts the request, so the fetch rejects here. A cancelled
      // submit is not a failed one: `onCanceled` has already reported it, and
      // a DOMException carries no `kind` for `<Form>` to read, so leaving it
      // in `error` only puts a value there that nothing can act on.
      if ((error as Error)?.name === "AbortError") {
        settle((prev) => prev);
        return;
      }
      // A `TypeError` from `fetch` (no answer) or a `SyntaxError` from
      // `response.json()` (an answer that was not JSON) — both `Error`s.
      options.onError(error as MutationError);
      call.onError?.(error as MutationError);
      // A parallel call's failure doesn't take back another call's result.
      settle((prev) => ({
        data: parallel ? prev.data : null,
        error: error as MutationError,
      }));
    }
  }

  trigger.formData = (formData: FormData) => {
    return trigger(formData as U);
  };

  return {
    data: state.data as T,
    error: state.error,
    loading: state.loading,
    // How many requests are on the wire. In parallel mode `loading` is
    // `pending > 0`.
    pending: state.pending,
    formData: formData.current,
    // Aborts the newest request, or in parallel mode every one in flight.
    cancel: () => {
      if (parallel) {
        // Each aborted call takes itself off `pending` as it settles, and
        // `loading` follows.
        for (const controller of inFlight.current) controller.abort();
      } else {
        abortController.current.abort();
        setState((prev) => ({ ...prev, loading: false }));
      }

      formData.current = new FormData();
      options.onCanceled?.();
    },
    trigger,
  };
}

export function usePost<
  K extends keyof Methods["POST"],
  T = Data<"POST", K>,
  E = ErrorOf<"POST", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T, E>>,
  ]
) {
  return useMutation("POST", url, ...(args as any));
}

export function usePut<
  K extends keyof Methods["PUT"],
  T = Data<"PUT", K>,
  E = ErrorOf<"PUT", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T, E>>,
  ]
) {
  return useMutation("PUT", url, ...(args as any));
}

export function usePatch<
  K extends keyof Methods["PATCH"],
  T = Data<"PATCH", K>,
  E = ErrorOf<"PATCH", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T, E>>,
  ]
) {
  return useMutation("PATCH", url, ...(args as any));
}

export function useDelete<
  K extends keyof Methods["DELETE"],
  T = Data<"DELETE", K>,
  E = ErrorOf<"DELETE", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T, E>>,
  ]
) {
  return useMutation("DELETE", url, ...(args as any));
}

export function useUpload<
  K extends keyof Methods["POST"],
  T = Data<"POST", K>,
  E = ErrorOf<"POST", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Omit<Config<T, E>, "concurrency">>,
  ]
) {
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">(
    "idle",
  );
  const [progress, setProgress] = useState(0);
  const _params = useParams();
  const { clearPrefetchCache } = useContext(ClientRouterContext);
  const abortRef = useRef<VoidFunction | null>(null);

  const [inputs = {}, options = defaultOptions] = args ?? [];

  // Clears the ref so a `cancel()` after the upload has settled does nothing:
  // it used to abort a finished request and report `onCanceled` for it.
  const cancel = () => {
    const abort = abortRef.current;
    if (!abort) return;
    abortRef.current = null;
    abort();
    options.onCanceled?.();
    setState("idle");
    setProgress(0);
  };

  // `undefined` for no file, a failed upload (reported through `onError`), a
  // network error or a `cancel()`, the same contract as `useMutation`'s
  // `trigger`. A cancel is not an error: `onCanceled` reports it and `onError`
  // does not run.
  //
  // It settles on the request's `load`/`error`/`timeout`/`abort` events. It
  // used to settle on `readyState` 4 by wrapping the answer in a `Response`,
  // which throws for the status 0 an abort or a dropped connection leaves —
  // inside an async handler, so the throw was an unhandled rejection and a
  // cancelled upload's `trigger` never settled (issue #671).
  const trigger = async (
    fileList: FileList | null | File,
  ): Promise<T | undefined> => {
    if (!fileList) {
      return;
    }
    const params =
      "params" in inputs ? { ..._params, ...inputs.params } : _params;
    const finalUrl = applyParams(String(url).replace("POST:", ""), params);

    const method = "POST";
    const action = `/api${finalUrl}`;
    const data = new FormData();
    if (fileList instanceof FileList) {
      for (const file of Array.from(fileList)) {
        data.append("file", file);
      }
    } else {
      data.append("file", fileList);
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    abortRef.current = abort;
    // A newer `trigger` owns the ref once it has replaced it.
    const release = () => {
      if (abortRef.current === abort) abortRef.current = null;
    };

    setState("uploading");
    setProgress(0);

    try {
      const outcome = await new Promise<
        | { type: "load"; status: number; statusText: string; body: string }
        | { type: "abort" }
      >((resolve, reject) => {
        xhr.addEventListener("load", () => {
          resolve({
            type: "load",
            status: xhr.status,
            statusText: xhr.statusText,
            body: xhr.responseText,
          });
        });
        xhr.addEventListener("abort", () => resolve({ type: "abort" }));
        xhr.addEventListener("error", () => {
          reject(new TypeError("Failed to fetch"));
        });
        xhr.addEventListener("timeout", () => {
          reject(new TypeError("Failed to fetch"));
        });

        xhr.upload.addEventListener("loadstart", () => {
          setProgress(0);
        });
        // `load`, not `loadend`: `loadend` follows an abort too, and put the
        // progress of a cancelled upload back to 1.
        xhr.upload.addEventListener("load", () => {
          setProgress(1);
        });
        xhr.upload.addEventListener("progress", (event) => {
          // A total the browser cannot tell is 0, and the ratio was `NaN`.
          if (event.lengthComputable && event.total > 0) {
            setProgress(event.loaded / event.total);
          }
        });

        xhr.open(method, action, true);
        xhr.send(data);
      });
      release();

      // `cancel()` has already reported it and put the state back to idle.
      if (outcome.type === "abort") {
        return;
      }

      if (outcome.status < 200 || outcome.status > 299) {
        let error: MutationError = {
          kind: "server_error",
          message: outcome.statusText,
          status: outcome.status,
        };
        try {
          error = mutationErrorFromBody(
            JSON.parse(outcome.body),
            outcome.status,
          );
        } catch {
          // Not JSON: a proxy's error page, say.
        }
        setState("error");
        options?.onError?.(error);
        return;
      }
      const json = JSON.parse(outcome.body);
      clearPrefetchCache?.();
      options?.onSuccess?.(json);
      setState("done");
      return json;
    } catch (error) {
      release();
      setState("error");
      options?.onError?.(error as MutationError);
      return;
    }
  };

  return {
    state,
    progress,
    trigger,
    cancel,
  };
}
