import { useCallback, useContext, useEffect } from "react";
import type { ApiRouterHandler } from "../http/ApiRouter";
import type { NestedPrettify, UnwrapPromise } from "../utils/type";
import type { RPC } from "./rpc";
import type { UrlParser } from "./types";
import { QueryManagerContext } from "./QueryManagerContext";
import { loadLazy } from "./lazyModule";
import { mutationExtras, preloadMutationExtras } from "./mutationModules";
import type { WriteQueryNext } from "./queryUpdates";
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
 *
 * The code behind the writes is loaded when the hook mounts. A call made
 * before it has arrived (during the first render, say) is written once it
 * has, in order.
 */
export function useSetQueryData() {
  const { getResource } = useContext(QueryManagerContext);
  const routeParams = useParams();
  // The writes are loaded on mount (#915), so by the time a handler calls the
  // setter they are normally there and it writes at once.
  useEffect(preloadMutationExtras, []);
  return useCallback(
    function setQueryData<P extends keyof GetRPC>(
      target: QueryTarget<P>,
      next: QueryData<P> | ((current: QueryData<P>) => QueryData<P>),
    ) {
      const write: WriteQueryNext =
        typeof next === "function"
          ? { update: next as (current: any) => unknown }
          : { value: next };
      const writes = mutationExtras.current;
      if (writes) {
        writes.writeQueryData(getResource, routeParams, target, write);
        return;
      }
      // Called before the module arrived: written once it has, in call
      // order. A failed load writes nothing.
      loadLazy(mutationExtras)
        .then((loaded) => loaded.writeQueryData(getResource, routeParams, target, write))
        .catch(() => {});
    },
    [getResource, routeParams],
  );
}
