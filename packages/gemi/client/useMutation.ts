import { useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { UnwrapPromise } from "../utils/type";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out.replace(`:${key}?`, value).replace(`:${key}`, value);
  }
  return out;
}

type Options = {
  autoInvalidate?: boolean;
};

type MutationInputs<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? { params: Params; query?: Record<string, any> }
    : never;

type Error = {};

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
  const [loading, setIsPending] = useState(false);
  const [data, setData] = useState(null);
  return {
    data,
    loading,
    error: {},
    trigger: async (input?: any) => {
      setIsPending(true);
      const [inputs, _options] = args;
      const {
        query: {},
      } = inputs;
      const params = "params" in inputs ? inputs.params : {};
      const [method, _url] = String(url).split(":");
      const finalUrl = applyParams(_url, params);
      const response = await fetch(`/api${finalUrl}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });

      const data = await response.json();
      setData(data);
      setIsPending(false);
      return data as any;
    },
  } as Mutation<RPC[T]>;
}
