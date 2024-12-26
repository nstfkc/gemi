import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { JSONLike } from "../utils/type";

import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";
import { applyParams } from "../utils/applyParams";
import type { UrlParser } from "./types";
import { omitNullishValues } from "../utils/omitNullishValues";
import { useParams } from "./useParams";

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

type Data<T extends keyof GetRPC> =
  GetRPC[T] extends ApiRouterHandler<any, infer Data, any>
    ? UnwrapPromise<Data>
    : never;

type Input<T extends keyof GetRPC> =
  GetRPC[T] extends ApiRouterHandler<infer I, any, any> ? I : never;

type QueryOptions<T extends keyof GetRPC> = {
  search?: Partial<WithOptionalValues<Input<T>>>;
};

type Error = {};

type CombineKeys<
  T extends PropertyKey,
  K extends PropertyKey,
> = `${T & string}.${K & string}`;

type NestedKeyof<T> = T extends JSONLike
  ? {
      [K in keyof T]: K extends string
        ? K | CombineKeys<K, NestedKeyof<T[K]>>
        : never;
    }[keyof T]
  : never;

type ValueAtPath<T, Path extends string> = T extends JSONLike
  ? Path extends keyof T
    ? T[Path]
    : Path extends `${infer K}.${infer R}`
      ? K extends keyof T
        ? ValueAtPath<T[K], R>
        : never
      : never
  : never;

const defaultOptions: QueryOptions<any> & { params?: Record<string, any> } = {
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
};

export function useQuery<T extends keyof GetRPC>(
  url: T,
  ...args: [
    options?: {
      search?: WithOptionalValues<Input<T>>;
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
  const [resource, setResource] = useState(() =>
    getResource(
      normalPath,
      config.fallbackData ? { [variantKey]: config.fallbackData } : null,
    ),
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

  const handleReload = useCallback(() => {
    setResource(getResource(applyParams(url, params)));
  }, [url, params]);

  useEffect(() => {
    // @ts-ignore
    if (import.meta.hot) {
      // @ts-ignore
      import.meta.hot.on("http-reload", mutate);
    }
    return () => {
      // @ts-ignore
      if (import.meta.hot) {
        // @ts-ignore
        import.meta.hot.off("http-reload", mutate);
      }
    };
  }, [handleReload]);

  useEffect(() => {
    const key = JSON.stringify(params);
    if (key !== paramsRef.current) {
      if (config.debug) {
        console.log("refetching - params changed", key, paramsRef.current);
      }
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

  function mutate(fn: Data<T>): void;
  function mutate(fn: (data: Data<T>) => Data<T>): void;
  function mutate<K extends NestedKeyof<Data<T>>, V = ValueAtPath<Data<T>, K>>(
    key: K,
    value: V | ((value: V) => V),
  ): void;
  function mutate(fn: any, value?: any) {
    return resource.mutate.call(resource, variantKey, (data: any) => {
      try {
        if (typeof fn === "function") {
          return fn(data);
        } else if (typeof fn === "string") {
          const keys = (fn as string).split(".");

          let current: any = structuredClone(data);

          for (let i = 0; i < keys.length - 1; i++) {
            const subKey = keys[i];
            current[subKey] = current[subKey] || {}; // Create the nested object if it doesn't exist
            current = current[subKey];
          }

          let newValue = value;

          if (typeof value === "function") {
            newValue = value(current[keys[keys.length - 1]]);
          }

          // Update the final key with the new value
          current[keys[keys.length - 1]] = newValue;

          return current;
        } else {
          return fn;
        }
      } catch (err) {
        console.log(err);
        // Do something
      }
      return data;
    });
  }

  return {
    data: state?.data as Data<T>,
    loading: state?.loading ?? true,
    error: state?.error as Error,
    mutate,
  };
}
