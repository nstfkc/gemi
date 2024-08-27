import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RPC } from "./rpc";
import type { JSONLike } from "../utils/type";

import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";
import { applyParams } from "../utils/applyParams";
import type { UrlParser } from "./types";

interface Config<T> {
  fallbackData?: T;
  keepPreviousData?: boolean;
  retryIntervalOnError?: number;
}

type WithOptionalValues<T> = {
  [K in keyof T]: T[K] | null;
};

const defaultConfig: Config<any> = {
  fallbackData: null,
  keepPreviousData: false,
  retryIntervalOnError: 10000,
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

const defaultOptions: QueryOptions<any> & { params: Record<string, any> } = {
  params: {} as Record<string, any>,
  search: {} as Record<string, string>,
};

export function useQuery<T extends keyof GetRPC>(
  url: T,
  ...args: UrlParser<`${T & string}`> extends Record<string, never>
    ? [
        options?: { search?: WithOptionalValues<Input<T>> },
        config?: Config<Data<T>>,
      ]
    : [
        options: { search?: WithOptionalValues<Input<T>> } & {
          params: UrlParser<`${T & string}`>;
        },
        config?: Config<Data<T>>,
      ]
) {
  const [_options = defaultOptions, _config = defaultConfig] = args;
  const options = { ...defaultOptions, ..._options };
  const config = { ...defaultConfig, ..._config };
  const params = "params" in options ? (options.params ?? {}) : {};
  const search = "search" in options ? (options.search ?? {}) : {};
  const { getResource } = useContext(QueryManagerContext);
  const normalPath = applyParams(url, params);
  const searchParams = new URLSearchParams(
    Object.fromEntries(
      Object.entries(search).filter(
        ([_k, v]) => v !== null && v !== undefined,
      ) as [],
    ),
  );
  searchParams.sort();
  const variantKey = searchParams.toString();
  const [resource] = useState(() =>
    getResource(normalPath, { [variantKey]: config.fallbackData }),
  );
  const retryIntervalRef = useRef<ReturnType<typeof setTimeout>>();
  const retryingMap = useRef<Map<string, boolean>>(new Map());
  const [state, setState] = useState(() => resource.getVariant(variantKey));

  const retry = (variantKey: string) => {
    if (!retryingMap.current.get(variantKey)) {
      retryingMap.current.set(variantKey, true);
      retryIntervalRef.current = setTimeout(() => {
        resource.getVariant(variantKey);
        retryingMap.current.set(variantKey, false);
      }, config.retryIntervalOnError);
    }
  };

  const handleStateUpdate = useCallback(
    (nextState) => {
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
  }, [variantKey]);

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
    loading: state?.loading as boolean,
    error: state?.error as Error,
    mutate,
  };
}
