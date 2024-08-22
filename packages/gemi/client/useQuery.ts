import { useContext, useEffect, useState } from "react";
import type { RPC } from "./rpc";
import type { JSONLike, Prettify } from "../utils/type";

import type { ApiRouterHandler } from "../http/ApiRouter";
import type { UnwrapPromise } from "../utils/type";
import { QueryManagerContext } from "./QueryManagerContext";
import { applyParams } from "../utils/applyParams";

interface Config<T> {
  fallbackData?: T;
  keepPreviousData?: boolean;
}

type WithOptionalValues<T> = {
  [K in keyof T]: T[K] | null;
};

const defaultConfig: Config<any> = {
  fallbackData: null,
  keepPreviousData: false,
};

type Data<T> =
  T extends ApiRouterHandler<any, infer Data, any>
    ? UnwrapPromise<Data>
    : never;

type QueryOptions<T> =
  T extends ApiRouterHandler<infer Input, any, infer Params>
    ? Params extends Record<string, never>
      ? { search: Partial<WithOptionalValues<Input>> }
      : { params: Params; search: Partial<WithOptionalValues<Input>> }
    : never;

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

const defaultOptions: QueryOptions<any> = {
  params: {} as Record<string, any>,
  search: {} as Record<string, string>,
};

export function useQuery<T extends keyof RPC>(
  url: T extends `GET:${string}` ? T : never,
  ...args: QueryOptions<RPC[T]> extends never
    ? [
        options?: Omit<QueryOptions<RPC[T]>, "params">,
        config?: Config<Data<RPC[T]>>,
      ]
    : [options: QueryOptions<RPC[T]>, config?: Config<Data<RPC[T]>>]
) {
  const [options = defaultOptions, config = defaultConfig] = args;
  const { getResource } = useContext(QueryManagerContext);
  const [, path] = url.split("GET:");
  const normalPath = applyParams(path, options.params as any);
  const searchParams = new URLSearchParams(options.search);
  searchParams.sort();
  const variantKey = searchParams.toString();
  const [resource] = useState(() =>
    getResource(normalPath, { [variantKey]: config.fallbackData }),
  );

  const [state, setState] = useState(() => resource.getVariant(variantKey));

  useEffect(() => {
    const state = resource.getVariant(variantKey);
    if (config.keepPreviousData) {
      if (state.loading) {
        setState((s) => ({ ...s, loading: true }));
      } else {
        setState(state);
      }
    } else {
      setState(state);
    }
    return resource.store.subscribe.call(resource.store, () => {
      setState(resource.getVariant(variantKey));
    });
  }, [variantKey, config.keepPreviousData]);

  function mutate(fn: Data<RPC[T]>): void;
  function mutate(fn: (data: Data<RPC[T]>) => Data<RPC[T]>): void;
  function mutate<
    K extends NestedKeyof<Data<RPC[T]>>,
    U = ValueAtPath<Data<RPC[T]>, K>,
  >(key: K, value: U | ((value: U) => U)): void;
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
    data: state.data as Prettify<Data<RPC[T]>>,
    loading: state.loading as boolean,
    error: state.error as Error,
    mutate,
  };
}
