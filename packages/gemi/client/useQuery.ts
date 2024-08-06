import { useContext, useState, useSyncExternalStore } from "react";
import type { RPC } from "./rpc";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";

interface Options<Params> {
  params: Params;
  query?: Record<string, any>;
}

interface Config<T> {
  pathPrefix?: string;
  fallbackData?: T;
}

const defaultConfig: Config<any> = {
  pathPrefix: "",
  fallbackData: null,
};

type Data<T> =
  T extends ApiRouterHandler<any, infer Data, any>
    ? UnwrapPromise<Data>
    : never;

type QueryOptions<T> =
  T extends ApiRouterHandler<any, any, infer Params>
    ? Params extends Record<string, any>
      ? Options<Params>
      : never
    : never;

type Error = {};

type QueryReturn<T> =
  T extends ApiRouterHandler<any, infer Data, any>
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
    ? [
        options?: Omit<QueryOptions<RPC[T]>, "params">,
        config?: Config<Data<RPC[T]>>,
      ]
    : [options: QueryOptions<RPC[T]>, config?: Config<Data<RPC[T]>>]
): QueryReturn<RPC[T]> {
  const defaultOptions: QueryOptions<any> = {
    params: {},
    query: {},
  };
  const [options = defaultOptions, config = defaultConfig] = args;
  const { manager } = useContext(QueryManagerContext);
  const [, path] = url.split("GET:");
  const fullUrl = ["GET:", config.pathPrefix, path].join("");
  const [resource] = useState(() =>
    manager.fetch(fullUrl, options, { fallbackData: config.fallbackData }),
  );

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
