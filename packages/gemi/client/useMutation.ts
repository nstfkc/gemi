import { useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import type { UrlParser } from "./types";

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

type Data<M extends keyof Methods, K extends keyof Methods[M]> =
  Methods[M][K] extends ApiRouterHandler<any, infer T, any>
    ? UnwrapPromise<T>
    : never;

type Body<M extends keyof Methods, K extends keyof Methods[M]> =
  Methods[M][K] extends ApiRouterHandler<infer T, any, any> ? T : never;

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
  ...args: ParseParams<K> extends Record<string, never>
    ? [options?: {}, config?: Partial<Config<T>>]
    : [options: { params: ParseParams<K> }, config?: Partial<Config<T>>]
) {
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    loading: false,
  });

  const [abortController, setAbortController] = useState(
    () => new AbortController(),
  );

  return {
    data: state.data as T,
    error: state.error as any,
    loading: state.loading,
    cancel: () => {
      const [, options = defaultOptions] = args ?? [];
      abortController.abort();
      setAbortController(new AbortController());
      setState({
        data: state.data,
        error: state.error,
        loading: false,
      });
      options.onCanceled();
    },
    trigger: async (input: U | FormData): Promise<T> => {
      setState({
        data: state.data,
        error: state.error,
        loading: true,
      });
      const [inputs = { params: {} }, options = defaultOptions] = args ?? [];
      const params = "params" in inputs ? inputs.params : {};
      const finalUrl = applyParams(
        String(url).replace(`${method}:`, ""),
        params,
      );

      let body = null;

      const contentType =
        input instanceof FormData ? {} : { "Content-Type": "application/json" };

      if (input instanceof FormData) {
        body = input;
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
          signal: abortController.signal,
        });
        const data = await response.json();

        if (!response.ok) {
          setState({
            data: null,
            error: data.error,
            loading: false,
          });

          options.onError(data);
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
        options.onError(error);
        setState({
          data: null,
          error,
          loading: false,
        });
      }
    },
  };
}

export function usePost<K extends keyof Methods["POST"], T = Data<"POST", K>>(
  url: K,
  ...args: ParseParams<K> extends Record<string, never>
    ? [options?: {}, config?: Partial<Config<T>>]
    : [options: { params: ParseParams<K> }, config?: Partial<Config<T>>]
) {
  return useMutation("POST", url, ...(args as any));
}

export function usePut<K extends keyof Methods["PUT"], T = Data<"PUT", K>>(
  url: K,
  ...args: ParseParams<K> extends Record<string, never>
    ? [options?: {}, config?: Partial<Config<T>>]
    : [options: { params: ParseParams<K> }, config?: Partial<Config<T>>]
) {
  return useMutation("PUT", url, ...(args as any));
}

export function usePatch<
  K extends keyof Methods["PATCH"],
  T = Data<"PATCH", K>,
>(
  url: K,
  ...args: ParseParams<K> extends Record<string, never>
    ? [options?: {}, config?: Partial<Config<T>>]
    : [options: { params: ParseParams<K> }, config?: Partial<Config<T>>]
) {
  return useMutation("PATCH", url, ...(args as any));
}

export function useDelete<
  K extends keyof Methods["DELETE"],
  T = Data<"DELETE", K>,
>(
  url: K,
  ...args: ParseParams<K> extends Record<string, never>
    ? [options?: {}, config?: Partial<Config<T>>]
    : [options: { params: ParseParams<K> }, config?: Partial<Config<T>>]
) {
  return useMutation("DELETE", url, ...(args as any));
}
