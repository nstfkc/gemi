import { useState } from "react";
import { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";

function applyParams(url: string, params: Record<string, any> = {}) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out.replace(`:${key}?`, value);
    out.replace(`:${key}`, value);
  }
  return out;
}

type Options<Params, Query = {}> = {
  params: Params;
  query: Query;
};

type EmptyOptions = {};

type MutationOptions<T> =
  T extends ApiRouterHandler<infer Input, any, infer Params>
    ? Options<Params>
    : never;

type Error = {};

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

type Mutation<T> =
  T extends ApiRouterHandler<infer Input, infer Output, any>
    ? {
        data: UnwrapPromise<Output>;
        loading: boolean;
        error: Error;
        trigger: (input: Input) => Promise<UnwrapPromise<Output>>;
      }
    : never;

type ParseParams<T> =
  T extends ApiRouterHandler<any, any, infer Params> ? Params : never;

type NotEmptyObject<T> = keyof T extends never ? never : T;

export function useMutation<T extends keyof RPC>(
  url: T extends `GET:${string}` ? never : T,
  ...args: ParseParams<RPC[T]> extends Record<string, never>
    ? [options?: Omit<MutationOptions<RPC[T]>, "params">]
    : [options: MutationOptions<RPC[T]>]
): Mutation<RPC[T]> {
  const [loading, setIsPending] = useState(false);
  const [data, setData] = useState(null);
  return {
    data,
    loading,
    error: {},
    trigger: async (input?: any) => {
      setIsPending(true);
      const [options] = args;
      const [method, _url] = String(url).split(":");
      const finalUrl = applyParams(_url, options.params);
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
