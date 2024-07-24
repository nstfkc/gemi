import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";
import { log } from "console";

interface Options<Params> {
  params: Params;
  query?: Record<string, any>;
}

type QueryOptions<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? Params extends Record<string, any>
      ? Options<Params>
      : never
    : never;

type Error = {};

type QueryReturn<T> =
  T extends ApiRouterHandler<infer Input, infer Data, any>
    ? {
        data: UnwrapPromise<Data>;
        loading: boolean;
        error: Error;
        mutate: (
          fn: (input: UnwrapPromise<Data>) => UnwrapPromise<Data>,
        ) => void;
      }
    : never;

export function useQuery<T extends keyof RPC>(
  url: T extends `GET:${string}` ? T : never,
  ...args: QueryOptions<RPC[T]> extends never
    ? []
    : [options: QueryOptions<RPC[T]>]
): QueryReturn<RPC[T]> {
  const defaultOptions: QueryOptions<any> = {
    params: {},
    query: {},
  };
  const options = args?.[0] ?? defaultOptions;
  const { manager } = useContext(QueryManagerContext);
  const [resource] = useState(() => manager.fetch(url, options));

  const state: any = useSyncExternalStore(
    resource.state.subscribe.bind(resource.state),
    resource.state.getValue.bind(resource.state),
    resource.state.getValue.bind(resource.state),
  );

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    mutate: resource.mutate.bind(resource),
  } as QueryReturn<RPC[T]>;
}
