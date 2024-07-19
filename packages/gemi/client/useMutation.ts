import { useState } from "react";
import { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";

function applyParams(url: string, params: Record<string, any>) {
  let out = url;

  for (const [key, value] of Object.entries(params)) {
    out.replace(`:${key}?`, value);
    out.replace(`:${key}`, value);
  }
  return out;
}

interface Options<Params> {
  params: Params;
}

type MutationOptions<T> =
  T extends ApiRouterHandler<infer Input, any, infer Params>
    ? Options<Params>
    : never;

type Error = {};

type Mutation<T> =
  T extends ApiRouterHandler<infer Input, infer Output, any>
    ? {
        data: Output;
        loading: boolean;
        error: Error;
        trigger: (input: Input) => Promise<Output>;
      }
    : never;

export function useMutation<T extends keyof RPC>(
  url: T extends `GET:${string}` ? never : T,
  options: MutationOptions<RPC[T]>,
): Mutation<RPC[T]> {
  const [loading, setIsPending] = useState(false);
  const [data, setData] = useState(null);
  return {
    data,
    loading,
    error: {},
    trigger: async (input?: any) => {
      setIsPending(true);
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
      return data;
    },
  };
}
