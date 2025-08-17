import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { JSONLike, NestedPrettify } from "../utils/type";

import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";
import { applyParams } from "../utils/applyParams";
import type { UrlParser } from "./types";
import { omitNullishValues } from "../utils/omitNullishValues";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";
import { isPlainObject } from "./isPlainObject";

interface Config<T> {
  fallbackData?: T;
  keepPreviousData?: boolean;
  retryIntervalOnError?: number;
  debug?: boolean;
}

type WithOptionalValues<T> = {
  [K in keyof T]: T[K] | null;
};

const defaultConfig: Config<any> = {
  fallbackData: null,
  keepPreviousData: true,
  retryIntervalOnError: 10000,
  debug: false,
};

type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

type Data<T extends keyof GetRPC> = GetRPC[T] extends ApiRouterHandler<
  any,
  infer Data,
  any
>
  ? UnwrapPromise<Data>
  : never;

type Input<T extends keyof GetRPC> = GetRPC[T] extends ApiRouterHandler<
  infer I,
  any,
  any
>
  ? I
  : never;

type QueryOptions<T extends keyof GetRPC> = {
  search?: Partial<WithOptionalValues<Input<T>>>;
};

type Error = Record<string, unknown>;

const defaultOptions: QueryOptions<any> & { params?: Record<string, any> } = {
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
};

export type QueryResult<T extends keyof GetRPC> = NestedPrettify<Data<T> & {}>;

export function useQuery<T extends keyof GetRPC>(
  url: T,
  ...args: [
    options?: {
      search?: Record<string, string | number | boolean | null>;
      params?: Partial<UrlParser<`${T & string}`>>;
    },
    config?: Config<Data<T>>,
  ]
) {
  const _params = useParams();
  const [_options = defaultOptions, _config = defaultConfig] = args;
  const options = { ...defaultOptions, ..._options };
  const config = { ...defaultConfig, ..._config };
  const params =
    "params" in options ? { ..._params, ...options.params } : _params;
  const paramsRef = useRef(JSON.stringify(params));
  const search = "search" in options ? (options.search ?? {}) : {};
  const { getResource } = useContext(QueryManagerContext);
  const normalPath = applyParams(url, params);
  const searchParams = new URLSearchParams(omitNullishValues(search));
  searchParams.sort();
  const variantKey = searchParams.toString();
  const { prefetchedData } = useRouteData();
  const fallbackData =
    config.fallbackData ?? prefetchedData?.[normalPath] ?? null;
  const [resource, setResource] = useState(() =>
    getResource(normalPath, fallbackData),
  );

  const retryIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryingMap = useRef<Map<string, boolean>>(new Map());
  const [state, setState] = useState(() => resource.getVariant(variantKey));

  const retry = (variantKey: string) => {
    if (!retryingMap.current.get(variantKey)) {
      if (config.debug) console.log("retrying", variantKey);
      retryingMap.current.set(variantKey, true);
      retryIntervalRef.current = setTimeout(() => {
        resource.getVariant(variantKey);
        retryingMap.current.set(variantKey, false);
      }, config.retryIntervalOnError);
    }
  };

  useEffect(() => {
    const key = JSON.stringify(params);
    if (key !== paramsRef.current) {
      setResource(getResource(applyParams(url, params)));
      setState(resource.getVariant(variantKey));
      paramsRef.current = key;
    }
  }, [params]);

  const handleStateUpdate = useCallback(
    (nextState) => {
      if (config.debug) {
        console.log("state updating due to url update", variantKey);
        console.log(nextState);
      }
      if (nextState.error) {
        retry(variantKey);
      }
      if (config.keepPreviousData) {
        if (nextState.loading) {
          setState((s) => ({ ...s, loading: true }));
        } else {
          setState(nextState);
        }
      } else {
        setState(nextState);
      }
    },
    [variantKey],
  );

  useEffect(() => {
    handleStateUpdate(resource.getVariant(variantKey));
    const unsub = resource.store.subscribe.call(resource.store, (store) => {
      handleStateUpdate(store.get(variantKey));
    });
    return () => {
      unsub();
      clearInterval(retryIntervalRef.current);
    };
  }, [variantKey, resource]);

  function mutate(fn: Partial<NestedPrettify<Data<T>>>): void;
  function mutate(
    fn: (data: NestedPrettify<Data<T>>) => Partial<NestedPrettify<Data<T>>>,
  ): void;
  function mutate(fn: any) {
    return resource.mutate.call(resource, variantKey, (data: any) => {
      if (data === undefined || data === null) {
        console.warn("Mutate function called before the query.");
        return;
      }

      const updatedData = typeof fn === "function" ? fn(data) : fn;

      if (isPlainObject(data)) {
        if (isPlainObject(updatedData)) {
          return { ...data, ...updatedData };
        }
        throw new Error(
          "Mutate function must return an object when the current data is an object.",
        );
      }

      if (Array.isArray(data)) {
        if (Array.isArray(updatedData)) {
          return [...data, ...updatedData];
        }
        throw new Error(
          "Mutate function must return an array when the current data is an array.",
        );
      }

      if (typeof data !== typeof updatedData) {
        throw new Error(
          "Mutate function must return the same type as the current data.",
        );
      }

      return updatedData;
    });
  }

  return {
    data: state?.data as NestedPrettify<Data<T>>,
    loading: state?.loading ?? true,
    error: state?.error as Error,
    mutate,
  };
}
