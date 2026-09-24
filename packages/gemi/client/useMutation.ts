import { useContext, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";
import { useParams } from "./useParams";
import { ClientRouterContext } from "./ClientRouterContext";

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

type Config<T> = {
  autoInvalidate?: boolean;
  onSuccess: (data: T) => void;
  onError: (error: MutationError) => void;
  onCanceled?: () => void;
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

type MutationError =
  | {
      kind: "validation_error";
      messages: Record<string, any>;
    }
  | {
      kind: "form_error";
      message: string;
    }
  | {
      kind: "server_error";
      message: string;
    }
  | {
      kind: "not_authorized";
      message: string;
    }
  | {
      kind: "insufficient_permissions";
      message: string;
    };

type ParseParams<T> = UrlParser<`${T & string}`>;

type State<T> = {
  data: T | null;
  error: MutationError | null;
  loading: boolean;
};

export function useMutation<
  M extends keyof Methods,
  K extends keyof Methods[M],
  T = Data<M, K>,
  U = Body<M, K>,
>(
  method: M,
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>>, search?: Record<string, string> },
    config?: Partial<Config<T>>,
  ]
) {
  const _params = useParams();
  // A write may have moved the data behind any page warmed ahead of a click,
  // and a prefetched payload is committed wholesale — into the query cache too.
  const { clearPrefetchCache } = useContext(ClientRouterContext);
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    loading: false,
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

  const formData = useRef(new FormData());

  // `Partial<Config<T>>` means a caller may name only the callbacks it wants,
  // and the framework's own `useSignIn`/`useSignOut` name only `onSuccess`.
  // Taking the config as given left the rest undefined, so a success called
  // `options.onSuccess(data)` on `undefined` and reported its own `TypeError`
  // through `onError`.
  const [inputs = {}, config] = args ?? [];
  const options: Config<T> = { ...defaultOptions, ...config };

  async function trigger(input?: U): Promise<T> {
    const controller = new AbortController();
    abortController.current = controller;
    const requestId = ++latestRequest.current;
    const isLatest = () => latestRequest.current === requestId;

    // The last response's error is about the last submit. Left in place, a
    // corrected resubmit shows the old validation message until it returns.
    setState((prev) => ({
      data: prev.data,
      error: null,
      loading: true,
    }));
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
      if (!isLatest()) return;

      formData.current = new FormData();

      if (!response.ok) {
        // `data` is the last result the caller was given, and a rejected
        // submit did not replace it — the same reason the pending state above
        // keeps it.
        setState((prev) => ({
          data: prev.data,
          error: data.error,
          loading: false,
        }));

        // `data.error` rather than the envelope around it: `onError` is typed
        // `(error: MutationError) => void`, and the envelope has no `kind` to
        // branch on.
        options.onError(data.error);
        return;
      }

      clearPrefetchCache?.();
      options.onSuccess(data);

      setState({
        data,
        error: null,
        loading: false,
      });

      return data as any;
    } catch (error) {
      if (!isLatest()) return;

      formData.current = new FormData();
      // `cancel()` aborts the request, so the fetch rejects here. A cancelled
      // submit is not a failed one: `onCanceled` has already reported it, and
      // a DOMException carries no `kind` for `<Form>` to read, so leaving it
      // in `error` only puts a value there that nothing can act on.
      if ((error as Error)?.name === "AbortError") {
        setState((prev) => ({ ...prev, loading: false }));
        return;
      }
      options.onError(error as MutationError);
      setState({
        data: null,
        error: error as MutationError,
        loading: false,
      });
    }
  }

  trigger.formData = (formData: FormData) => {
    return trigger(formData as U);
  };

  return {
    data: state.data as T,
    error: state.error as any,
    loading: state.loading,
    formData: formData.current,
    cancel: () => {
      abortController.current.abort();
      setState((prev) => ({ ...prev, loading: false }));

      formData.current = new FormData();
      options.onCanceled?.();
    },
    trigger,
  };
}

export function usePost<K extends keyof Methods["POST"], T = Data<"POST", K>>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
  ]
) {
  return useMutation("POST", url, ...(args as any));
}

export function usePut<K extends keyof Methods["PUT"], T = Data<"PUT", K>>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
  ]
) {
  return useMutation("PUT", url, ...(args as any));
}

export function usePatch<
  K extends keyof Methods["PATCH"],
  T = Data<"PATCH", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
  ]
) {
  return useMutation("PATCH", url, ...(args as any));
}

export function useDelete<
  K extends keyof Methods["DELETE"],
  T = Data<"DELETE", K>,
>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
  ]
) {
  return useMutation("DELETE", url, ...(args as any));
}

export function useUpload<K extends keyof Methods["POST"], T = Data<"POST", K>>(
  url: K,
  ...args: [
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
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

  const cancel = () => {
    if (abortRef.current) {
      abortRef.current();
      options.onCanceled?.();
      setState("idle");
      setProgress(0);
    }
  };

  const trigger = async (fileList: FileList | null | File): Promise<T> => {
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
    abortRef.current = () => {
      xhr.abort();
    };

    try {
      const result = await new Promise<Response>((resolve, reject) => {
        xhr.responseType = "blob";
        xhr.onreadystatechange = async () => {
          if (xhr.readyState !== 4) {
            // done
            return;
          }

          const response = new Response(xhr.response, {
            status: xhr.status,
            statusText: xhr.statusText,
          });

          resolve(response);
        };

        xhr.addEventListener("error", () => {
          reject(new TypeError("Failed to fetch"));
        });

        xhr.upload.addEventListener("loadstart", () => {
          setProgress(0);
        });
        xhr.upload.addEventListener("loadend", () => {
          setProgress(1);
        });

        xhr.upload.addEventListener("progress", (event) => {
          setProgress(event.loaded / event.total);
        });

        xhr.open(method, action, true);
        xhr.send(data);
      });
      setState("uploading");
      if (!result.ok) {
        let error: MutationError = {
          kind: "server_error",
          message: result.statusText,
        };
        try {
          const data = await result.json();
          error = data.error;
        } catch (e) {
          // do nothing
        }
        setState("error");
        options?.onError?.(error);
        return;
      }
      const json = await result.json();
      clearPrefetchCache?.();
      options?.onSuccess?.(json);
      return json;
    } catch (error) {
      setState("error");
      options?.onError?.(error);
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
