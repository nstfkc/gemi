import { useCallback, useContext } from "react";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { NestedPrettify, UnwrapPromise } from "../utils/type";
import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";
import type { RPC } from "./rpc";
import type { UrlParser } from "./types";
import type { QueryResource } from "./QueryResource";
import { QueryManagerContext } from "./QueryManagerContext";
import { useParams } from "./useParams";

type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

/** The data a `useQuery` of this path reads. */
type QueryData<P extends keyof GetRPC> = NestedPrettify<
  GetRPC[P] extends ApiRouterHandler<any, infer Data, any> ? UnwrapPromise<Data> : never
>;

/**
 * The cached query a write lands in: the `useMutate` target. `search` is one
 * variant (the one a `useQuery` with that `search` reads), or a predicate
 * over every variant the cache holds for the path. `params` are merged over
 * the current route's, as `useQuery` merges them.
 */
export type QueryTarget<P extends keyof GetRPC> = {
  path: P;
  params?: Partial<UrlParser<`${P & string}`>>;
  search?: Record<string, any> | ((search: URLSearchParams) => boolean);
};

/**
 * One entry of a mutation's `updates`: a query its answer (`T`) is written
 * into, with no refetch. Without `data` the answer is written as is, which
 * only type-checks when it is the path's data. `data` builds the next value
 * from the answer and what is cached, and is skipped for a variant with
 * nothing cached.
 */
export type QueryUpdate<T> = {
  [P in keyof GetRPC]: QueryTarget<P> &
    ([T] extends [QueryData<P>]
      ? { data?: (answer: T, current: QueryData<P>) => QueryData<P> }
      : { data: (answer: T, current: QueryData<P>) => QueryData<P> });
}[keyof GetRPC];

type Resolve = (key: string) => QueryResource;

/**
 * Write into every variant `target` names. `next` is the value to write, or
 * a function of the cached value; a function skips a variant with nothing
 * cached. A value seeds a single variant that is not cached yet; a predicate
 * only ever reaches variants that are.
 */
export function writeQueryData(
  getResource: Resolve,
  routeParams: Record<string, any>,
  target: QueryTarget<any>,
  next: { value: unknown } | { update: (current: any) => unknown },
) {
  const { path, params = {}, search = {} } = target;
  const resource = getResource(applyParams(String(path), { ...routeParams, ...params }));
  const write = (variantKey: string) => {
    if ("value" in next) {
      resource.set(variantKey, next.value);
      return;
    }
    const state = resource.peek(variantKey);
    if (!state?.hasData) return;
    resource.set(variantKey, next.update(state.data));
  };

  if (typeof search === "function") {
    for (const variantKey of resource.variantKeys()) {
      if (!resource.peek(variantKey)?.hasData) continue;
      if (search(new URLSearchParams(variantKey))) write(variantKey);
    }
    return;
  }
  write(toVariantKey(search));
}

/**
 * Write a mutation's `updates` with its answer.
 */
export function applyQueryUpdates(
  getResource: Resolve,
  routeParams: Record<string, any>,
  updates: ReadonlyArray<QueryUpdate<any>> | undefined,
  answer: unknown,
) {
  for (const update of updates ?? []) {
    const { data } = update as { data?: (answer: any, current: any) => any };
    writeQueryData(
      getResource,
      routeParams,
      update,
      data ? { update: (current) => data(answer, current) } : { value: answer },
    );
  }
}

/**
 * Returns a function that writes into any query's cache by path, with no
 * refetch: for data the server already answered with. `useMutate` is the
 * optimistic counterpart, which refetches to reconcile.
 *
 * ```ts
 * const setQueryData = useSetQueryData();
 * setQueryData({ path: "/pages/:pageId/assets", params: { pageId } }, assets);
 * setQueryData({ path: "/todos", search: () => true }, (todos) => todos.slice(1));
 * ```
 *
 * A value replaces the variant's data, and seeds it when nothing is cached
 * yet. A function updates what is cached and skips a variant with nothing
 * cached. A predicate `search` reaches every cached variant it accepts.
 */
export function useSetQueryData() {
  const { getResource } = useContext(QueryManagerContext);
  const routeParams = useParams();
  return useCallback(
    function setQueryData<P extends keyof GetRPC>(
      target: QueryTarget<P>,
      next: QueryData<P> | ((current: QueryData<P>) => QueryData<P>),
    ) {
      writeQueryData(
        getResource,
        routeParams,
        target,
        typeof next === "function"
          ? { update: next as (current: any) => unknown }
          : { value: next },
      );
    },
    [getResource, routeParams],
  );
}
