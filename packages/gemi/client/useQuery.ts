import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";

interface Options<Params> {
  params: Params;
  query: Record<string, any>;
}

type QueryOptions<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? Params extends Record<string, any>
      ? Options<Params>
      : never
    : never;

type Error = {};

type QueryReturn<T> =
  T extends ApiRouterHandler<any, infer Output, any>
    ? { data: UnwrapPromise<Output>; loading: boolean; error: Error }
    : never;

export function useQuery<T extends keyof RPC>(
  url: T extends `GET:${string}` ? T : never,
  ...args: QueryOptions<RPC[T]> extends never
    ? []
    : [options: QueryOptions<RPC[T]>]
): QueryReturn<RPC[T]> {
  const { manager } = useContext(QueryManagerContext);
  const [resource] = useState(() => manager.getResource(key));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const _data = useSyncExternalStore(
    resource.data.subscribe,
    resource.data.getValue,
    resource.data.getValue,
  );

  useEffect(() => {
    async function execute() {
      setLoading(true);
      try {
        const [, _url] = String(key).split(":");
        const res = await fetch(`/api${key}`);
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
  }, [key, options]);

  return { data, loading, error } as QueryReturn<RPC[T]>;
}
