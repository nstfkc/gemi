import { useContext } from "react";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { NestedPrettify, UnwrapPromise } from "../utils/type";
import { isPlainObject } from "./isPlainObject";

import type { RPC } from "./rpc";
import { QueryManagerContext } from "./QueryManagerContext";
import type { UrlParser } from "./types";
import { applyParams } from "../utils/applyParams";
import { omitNullishValues } from "../utils/omitNullishValues";
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

export function useMutate() {
  const { getResource } = useContext(QueryManagerContext);
  return function mutate<T extends keyof GetRPC>(
    options: {
      path: T;
      params?: UrlParser<`${T & string}`>;
      search?: Record<string, any>;
    },
    fn?:
      | ((data: NestedPrettify<Data<T>>) => Partial<NestedPrettify<Data<T>>>)
      | Partial<NestedPrettify<Data<T>>>,
  ) {
    const { path, params = {}, search = {} } = options ?? {};
    const normalPath = applyParams(path, params);
    const resource = getResource(normalPath);
    const searchParams = new URLSearchParams(omitNullishValues(search));
    searchParams.sort();
    const variantKey = searchParams.toString();
    return resource.mutate.call(resource, variantKey, (data: any) => {
      if (data === undefined || data === null) {
        console.warn("Mutate function called before the query.");
        return;
      }

      if (!fn) {
        return data;
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
  };
}
