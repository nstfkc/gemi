import { useContext } from "react";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { NestedPrettify, UnwrapPromise } from "../utils/type";
import { isPlainObject } from "./isPlainObject";

import type { RPC } from "./rpc";
import { QueryManagerContext } from "./QueryManagerContext";
import type { UrlParser } from "./types";
import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";
type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

type Data<T extends keyof GetRPC> =
  GetRPC[T] extends ApiRouterHandler<any, infer Data, any>
    ? UnwrapPromise<Data>
    : never;

/**
 * Which cached search variants of the path a call updates: one search object
 * (the variant a `useQuery` with that `search` reads), or a predicate over
 * every variant the cache holds for the path.
 */
type SearchTarget =
  | Record<string, any>
  | ((search: URLSearchParams) => boolean);

/**
 * The shape guard both `mutate` forms apply: the callback's return value
 * *replaces* the cached data, so it has to keep the data's shape — a stray
 * value must not corrupt the cache. It does not merge or append.
 */
function applyUpdate(data: any, fn: unknown) {
  const updatedData = typeof fn === "function" ? fn(data) : fn;

  if (isPlainObject(data)) {
    if (isPlainObject(updatedData)) {
      return updatedData;
    }
    throw new Error(
      "Mutate function must return an object when the current data is an object.",
    );
  }

  if (Array.isArray(data)) {
    if (Array.isArray(updatedData)) {
      return updatedData;
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
}

export function useMutate() {
  const { getResource } = useContext(QueryManagerContext);
  return function mutate<T extends keyof GetRPC>(
    options: {
      path: T;
      params?: UrlParser<`${T & string}`>;
      search?: SearchTarget;
    },
    fn?:
      | ((data: NestedPrettify<Data<T>>) => NestedPrettify<Data<T>>)
      | NestedPrettify<Data<T>>,
  ) {
    const { path, params = {}, search = {} } = options ?? {};
    const normalPath = applyParams(path, params);
    const resource = getResource(normalPath);

    if (typeof search === "function") {
      // Every cached variant the predicate accepts — e.g. `() => true` for
      // all of them, pages of a `useInfiniteQuery` included. Variants on
      // screen refetch now; the rest are marked stale and revalidate when
      // next read, so a path with many cached searches doesn't burst.
      for (const variantKey of resource.variantKeys()) {
        if (!search(new URLSearchParams(variantKey))) continue;
        resource.invalidate(
          variantKey,
          fn === undefined
            ? undefined
            : (data: any) => (data === null ? data : applyUpdate(data, fn)),
        );
      }
      return;
    }

    const variantKey = toVariantKey(search);
    return resource.mutate.call(resource, variantKey, (data: any) => {
      if (data === undefined || data === null) {
        console.warn("Mutate function called before the query.");
        return data;
      }

      if (!fn) {
        return data;
      }

      return applyUpdate(data, fn);
    });
  };
}
