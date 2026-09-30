import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { NestedPrettify } from "../utils/type";
import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";
import { QueryConfigContext, QueryManagerContext } from "./QueryManagerContext";
import type { QueryResource } from "./QueryResource";
import { useParams } from "./useParams";
import { useRouteData } from "./useRouteData";
import {
  useQuery,
  type Config,
  type Data,
  type GetRPC,
  type Options,
} from "./useQuery";

type Page<T extends keyof GetRPC> = NestedPrettify<Data<T>>;

/** What a page's `getNextPage` points at: a page number or a cursor. */
type PageCursor = string | number;

/** A page that is an array is its own list of items. */
type DefaultItem<P> = P extends readonly (infer U)[] ? U : never;

export interface InfiniteQueryConfig<P, Item> extends Omit<
  Config<P>,
  "lazy" | "refetchUntil" | "fallbackData"
> {
  /**
   * The next page's cursor, read off the pages loaded so far — usually a page
   * number, e.g. `(last, pages) => last.length === 48 ? pages.length + 1 :
   * null`. `null`/`undefined`/`false` means there is no next page, which is
   * what `hasMore` reports.
   */
  getNextPage: (
    lastPage: P,
    pages: P[],
  ) => PageCursor | null | undefined | false;
  /**
   * The search key the cursor is sent under (default `"page"`). The first
   * page is requested *without* it, so it is the same cached variant a plain
   * `useQuery` — and a `Query.prefetch` — with the same `search` reads.
   */
  pageParam?: string;
  /** A page's rows. Defaults to the page itself when it is an array. */
  getItems?: (page: P) => readonly Item[];
  /**
   * An item's identity. With it, a row that shifts into the next page (an
   * insert or delete between two offset-based fetches) is kept at its first
   * position instead of being rendered twice.
   */
  getKey?: (item: Item) => unknown;
}

export interface InfiniteQueryReturn<P, Item> {
  /** Every loaded page, in order. Empty until the first page has data. */
  pages: P[];
  /** The pages' rows flattened, de-duplicated by `getKey` when given. */
  items: Item[];
  /** Whether `getNextPage` points past the last loaded page. */
  hasMore: boolean;
  /**
   * Load the next page. A no-op while one is loading or when there is none;
   * when the last requested page failed, it retries that page.
   */
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  /** The first page's `loading` — see `useQuery`. */
  loading: boolean;
  error: Record<string, unknown> | null;
  /** Refetch every loaded page. */
  refetch: () => void;
}

type VariantState = ReturnType<QueryResource["peek"]>;

/**
 * Follows the cursor chain through the cache: the first page, then
 * `getNextPage` of it, and so on, up to `count` pages. Stops at the first page
 * that has no data yet — that one is loading (or failed).
 */
function walkPages(
  resource: QueryResource,
  firstKey: string,
  search: Record<string, unknown>,
  pageParam: string,
  count: number,
  getNextPage: (
    last: any,
    pages: any[],
  ) => PageCursor | null | undefined | false,
) {
  const keys = [firstKey];
  const states: VariantState[] = [resource.peek(firstKey)];
  const pages: any[] = [];
  let next: PageCursor | null | undefined | false = null;
  for (let i = 0; i < count; i++) {
    const state = states[i];
    if (!state?.hasData) break;
    pages.push(state.data);
    next = getNextPage(state.data, pages.slice());
    if (next === null || next === undefined || next === false) break;
    if (i + 1 === count) break;
    const key = toVariantKey({ ...search, [pageParam]: next });
    keys.push(key);
    states.push(resource.peek(key));
  }
  return { keys, states, pages, next };
}

/**
 * A paged list whose pages live in the query cache: page 1 is a plain
 * `useQuery` (so it suspends, SSR-renders and `Query.prefetch`es exactly like
 * one), and each further page is the same path with `pageParam` added to the
 * search — its own cached variant, which `useMutate` updates and invalidates
 * like any other. Changing `params` or `search` starts over from page 1.
 */
export function useInfiniteQuery<
  T extends keyof GetRPC,
  Item = DefaultItem<Page<T>>,
>(
  url: T,
  options: Options<T> | undefined,
  config: InfiniteQueryConfig<Page<T>, Item>,
): InfiniteQueryReturn<Page<T>, Item> {
  const {
    getNextPage,
    pageParam = "page",
    getItems,
    getKey,
    ...queryConfig
  } = config;

  const first = useQuery(url, options, queryConfig as Config<Data<T>>);

  const routeParams = useParams();
  const params =
    options && "params" in options
      ? { ...routeParams, ...options.params }
      : routeParams;
  const search: Record<string, unknown> = options?.search ?? {};
  const path = applyParams(url, params);
  const firstKey = toVariantKey(search);
  const listKey = `${path}?${firstKey}`;
  const { getResource } = useContext(QueryManagerContext);
  const appConfig = useContext(QueryConfigContext);
  const { prefetchedData } = useRouteData();
  // Seeded the way `useQuery` seeds it: during a params change `useQuery` is
  // still reading the previous path, so this may be the first `getResource`
  // for the new one, and the prefetch payload must not be lost to it.
  const resource = getResource(path, prefetchedData?.[path] ?? undefined);

  // How many pages this list has asked for. Keyed by the list, so a
  // params/search change drops it back to one page in the same render.
  const [requested, setRequested] = useState({ listKey, count: 1 });
  const count = requested.listKey === listKey ? requested.count : 1;

  const getNextPageRef = useRef(getNextPage);
  getNextPageRef.current = getNextPage;

  // The snapshot is the tuple of variant states along the chain; it keeps its
  // identity until one of them is written, as `useSyncExternalStore` needs.
  const snapshotRef = useRef<ReturnType<typeof walkPages> | null>(null);
  const getSnapshot = useCallback(() => {
    const walked = walkPages(
      resource,
      firstKey,
      search,
      pageParam,
      count,
      getNextPageRef.current,
    );
    const previous = snapshotRef.current;
    if (
      previous &&
      previous.keys.length === walked.keys.length &&
      previous.keys.every((key, i) => key === walked.keys[i]) &&
      previous.states.every((state, i) => state === walked.states[i])
    ) {
      return previous;
    }
    snapshotRef.current = walked;
    return walked;
    // `search` is captured through `firstKey`, its serialization.
  }, [resource, firstKey, pageParam, count]);
  const chain = useSyncExternalStore(
    resource.store.subscribe,
    getSnapshot,
    getSnapshot,
  );

  // Pages past the first: `useQuery` owns page 1. Retained while on screen so
  // an invalidation refetches them now, and fetched when missing or stale.
  const laterKeys = chain.keys.slice(1);
  const laterKeysId = laterKeys.join("\n");
  const staleTime = queryConfig.staleTime ?? appConfig?.staleTime;
  const staleTimeRef = useRef(staleTime);
  staleTimeRef.current = staleTime;
  // Each page is read once when it joins the list — fetched when missing,
  // revalidated when stale — not again on every later `fetchNextPage`. A new
  // list (params/search change) starts a new record, so returning to a filter
  // revalidates its pages again as they are loaded.
  const ensuredRef = useRef({ listKey, keys: new Set<string>() });
  useEffect(() => {
    if (!laterKeysId) return;
    if (ensuredRef.current.listKey !== listKey) {
      ensuredRef.current = { listKey, keys: new Set() };
    }
    const ensured = ensuredRef.current.keys;
    const keys = laterKeysId.split("\n");
    const releases = keys.map((key) => resource.retain(key));
    for (const key of keys) {
      if (ensured.has(key)) continue;
      ensured.add(key);
      resource.getVariant(key, staleTimeRef.current);
    }
    return () => releases.forEach((release) => release());
  }, [resource, listKey, laterKeysId]);

  // Until this list's page 1 is cached, show what `useQuery` shows. During a
  // variant change under `keepPreviousData` that is the previous list's
  // data, so every page of the previous list stays on screen rather than
  // collapsing to its first; otherwise (the server render) it is page 1.
  const ownFirstPage = chain.states[0]?.hasData === true;
  const fallbackPage = ownFirstPage ? undefined : first.data;
  const keepingPrevious =
    !ownFirstPage && fallbackPage !== undefined && first.loading;
  const shownRef = useRef<Page<T>[] | null>(null);
  const pages = useMemo<Page<T>[]>(
    () =>
      ownFirstPage
        ? chain.pages
        : keepingPrevious && shownRef.current
          ? shownRef.current
          : fallbackPage !== undefined
            ? [fallbackPage as Page<T>]
            : [],
    [ownFirstPage, chain, keepingPrevious, fallbackPage],
  );
  useEffect(() => {
    if (ownFirstPage) shownRef.current = pages;
  }, [ownFirstPage, pages]);

  const pending = chain.states[chain.pages.length];
  const allLoaded = ownFirstPage && chain.pages.length === chain.keys.length;
  const hasMore =
    allLoaded &&
    chain.next !== null &&
    chain.next !== undefined &&
    chain.next !== false;
  const isFetchingNextPage =
    ownFirstPage && chain.pages.length < chain.keys.length && !pending?.error;
  const pageError =
    ownFirstPage && chain.pages.length < chain.keys.length
      ? (pending?.error ?? null)
      : null;

  const items = useMemo(() => {
    const out: Item[] = [];
    const seen = new Set<unknown>();
    for (const page of pages) {
      const rows = getItems
        ? getItems(page)
        : Array.isArray(page)
          ? (page as unknown as Item[])
          : [];
      for (const row of rows) {
        if (getKey) {
          const key = getKey(row);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(row);
      }
    }
    return out;
  }, [pages, getItems, getKey]);

  const fetchNextPage = useCallback(() => {
    if (pageError) {
      resource.refetch(chain.keys[chain.keys.length - 1]);
      return;
    }
    if (!hasMore) return;
    setRequested((current) => ({
      listKey,
      count: (current.listKey === listKey ? current.count : 1) + 1,
    }));
  }, [pageError, hasMore, resource, chain, listKey]);

  const refetch = useCallback(() => {
    for (const key of chain.keys) {
      resource.refetch(key);
    }
  }, [resource, chain]);

  return {
    pages,
    items,
    hasMore,
    fetchNextPage,
    isFetchingNextPage,
    loading: first.loading,
    error: first.error ?? pageError,
    refetch,
  };
}
