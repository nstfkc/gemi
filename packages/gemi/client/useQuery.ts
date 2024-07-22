import { useEffect, useState } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { UnwrapPromise } from "../utils/type";

interface Options<Input, Params> {
  input: Input;
  params: Params;
}

type QueryOptions<T> =
  T extends ApiRouterHandler<infer Input, any, infer Params>
    ? Options<Input, Params>
    : never;

type Error = {};

type QueryReturn<T> =
  T extends ApiRouterHandler<any, infer Output, any>
    ? { data: UnwrapPromise<Output>; loading: boolean; error: Error }
    : never;

export function useQuery<T extends keyof RPC>(
  url: T extends `GET:${string}` ? T : never,
  options: QueryOptions<RPC[T]>,
): QueryReturn<RPC[T]> {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function execute() {
      setLoading(true);
      try {
        const [, _url] = String(url).split(":");
        const res = await fetch(`/api${url}`);
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        setError(JSON.stringify(err));
      } finally {
        setLoading(false);
      }
    }

    execute();
  }, [url, options]);

  return { data, loading, error } as QueryReturn<RPC[T]>;
}
