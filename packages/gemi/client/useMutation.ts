import { useContext, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";
import { useParams } from "./useParams";
import { HttpClientContext } from "./HttpClientContext";

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
    options?: { params?: Partial<ParseParams<K>> },
    config?: Partial<Config<T>>,
  ]
) {
  const _params = useParams();
  const { fetch, host } = useContext(HttpClientContext);
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    loading: false,
  });

  const [abortController, setAbortController] = useState(
    () => new AbortController(),
  );

  const formData = useRef(new FormData());

  async function trigger(input?: U): Promise<T> {
    setState({
      data: state.data,
      error: state.error,
      loading: true,
    });
    const [inputs = {}, options = defaultOptions] = args ?? [];
    const params =
      "params" in inputs ? { ..._params, ...inputs.params } : _params;
    const finalUrl = applyParams(String(url).replace(`${method}:`, ""), params);

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
      const response = await fetch(`${host}/api${finalUrl}`, {
        method,
        headers: {
          ...contentType,
        },
        ...(body ? { body } : {}),
        signal: abortController.signal,
      });

      formData.current = new FormData();

      const data = await response.json();

      if (!response.ok) {
        setState({
          data: null,
          error: data.error,
          loading: false,
        });

        options?.onError?.(data);
        return;
      }

      options.onSuccess(data);

      setState({
        data,
        error: null,
        loading: false,
      });

      return data as any;
    } catch (error) {
      formData.current = new FormData();
      options?.onError?.(error);
      setState({
        data: null,
        error,
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
      const [, options = defaultOptions] = args ?? [];
      abortController.abort();
      setAbortController(new AbortController());
      setState({
        data: state.data,
        error: state.error,
        loading: false,
      });

      formData.current = new FormData();
      options.onCanceled();
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
  const abortRef = useRef<VoidFunction | null>(null);
  const { host } = useContext(HttpClientContext);

  const [inputs = {}, options = defaultOptions] = args ?? [];

  const cancel = () => {
    if (abortRef.current) {
      abortRef.current();
      options.onCanceled?.();
      setState("idle");
      setProgress(0);
    }
  };

  const trigger = async (file: File): Promise<T> => {
    const params =
      "params" in inputs ? { ..._params, ...inputs.params } : _params;
    const finalUrl = applyParams(String(url).replace("POST:", ""), params);

    const method = "POST";
    const action = `${host}/api${finalUrl}`;
    const data = new FormData();
    data.append("file", file);
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
