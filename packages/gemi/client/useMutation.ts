import { useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}?`, value).replace(`:${key}`, value);
  }
  return out;
}

type Options = {
  autoInvalidate?: boolean;
  pathPrefix?: string;
  onSuccess: (data: any) => void;
  onError: (error: any) => void;
};

const defaultOptions: Options = {
  autoInvalidate: false,
  pathPrefix: "",
  onSuccess: () => {},
  onError: () => {},
};

type MutationInputs<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? { params: Params; query?: Record<string, any> }
    : never;

type Error =
  | {
      kind: "validation_error";
      messages: Record<string, any>;
    }
  | {
      kind: "form_error";
      message: string;
    };

type Mutation<T> =
  T extends ApiRouterHandler<infer Input, infer Output, any>
    ? {
        data: UnwrapPromise<Output>;
        loading: boolean;
        error: Error;
        trigger: (
          ...args: Input extends Record<string, never> ? [] : [input: Input]
        ) => Promise<UnwrapPromise<Output>>;
      }
    : never;

type ParseParams<T> =
  T extends ApiRouterHandler<any, any, infer Params> ? Params : never;

export function useMutation<T extends keyof RPC>(
  url: T extends `GET:${string}` ? never : T,
  ...args: ParseParams<RPC[T]> extends Record<string, never>
    ? [
        inputs?: Omit<MutationInputs<RPC[T]>, "params">,
        options?: Partial<Options>,
      ]
    : [inputs: MutationInputs<RPC[T]>, options?: Partial<Options>]
): Mutation<RPC[T]> {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: false,
  });
  return {
    ...state,
    trigger: async (input?: Record<string, any> | FormData) => {
      setState((state) => ({
        data: state.data,
        error: state.error,
        loading: true,
      }));
      const [inputs = { params: {}, query: {} }, options = defaultOptions] =
        args ?? [];
      const { pathPrefix = "" } = options;
      const { query = {} } = inputs ?? {};
      const params = "params" in inputs ? inputs.params : {};
      const [method] = String(url).split(":");
      const finalUrl = [
        applyParams(String(url).replace(`${method}:`, ""), params),
        new URLSearchParams(query).toString(),
      ].join("?");

      let body = null;

      const contentType =
        input instanceof FormData ? {} : { "Content-Type": "application/json" };

      if (input instanceof FormData) {
        body = input;
      } else if (input) {
        body = JSON.stringify(input);
      }

      const response = await fetch(`/api${pathPrefix}${finalUrl}`, {
        method,
        headers: {
          ...contentType,
        },
        ...(body ? { body } : {}),
      });

      try {
        const data = await response.json();

        if (!response.ok) {
          setState(() => ({
            data: null,
            error: data.error,
            loading: false,
          }));
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
        setState((state) => ({
          data: state.data,
          error,
          loading: false,
        }));
      }
    },
  } as Mutation<RPC[T]>;
}
