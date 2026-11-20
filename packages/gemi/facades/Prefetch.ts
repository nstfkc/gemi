import type { RPC } from "../client/rpc";
import type { UrlParser } from "../client/types";
import type { ApiRouterHandler } from "../http/ApiRouter";
import { RequestContext } from "../http/requestContext";
import { ServerQueryStore, type ServerQueryEntry } from "../services/router/ServerQueryStore";
import { createServerQueryFetcher } from "../services/router/serverQueryFetcher";
import {
  INVALIDATE_HEADER,
  decodeInvalidationKeys,
  encodeInvalidationKeys,
} from "../utils/invalidation";

type GetRPC = {
  [K in keyof RPC as K extends `GET:${infer P}` ? P : never]: RPC[K];
};

type Data<T extends keyof GetRPC> = GetRPC[T] extends ApiRouterHandler<
  any,
  infer Data,
  any
>
  ? Awaited<Data>
  : never;

type QueryFacadeOptions<T extends keyof GetRPC> = {
  search?: Record<string, string | number | boolean | null>;
  params?: Partial<UrlParser<T>>;
};

/** A query's path, a `path?search` variant, or a prefix ending in `*`. */
type InvalidationKey = keyof GetRPC | (string & {});

export class Query {
  private static ensure<T extends keyof GetRPC>(
    path: T,
    options: QueryFacadeOptions<T> = {},
  ): ServerQueryEntry {
    const ctx = RequestContext.getStore();

    if (ctx.req.kind === "api") {
      throw new Error("Query.prefetch() cannot be called from an API request");
    }

    // The view router creates the store up front; this lazy fallback keeps the
    // facade usable anywhere else a view-kind request context exists.
    ctx.serverQueries ??= new ServerQueryStore(
      createServerQueryFetcher(ctx.req.rawRequest),
    );

    return ctx.serverQueries.ensure(path, options, "prefetch");
  }

  /**
   * Start the query AND wait for it — the response cannot begin until it
   * resolves, so its data is part of the first paint. Use for data the shell
   * itself needs; `prefetch` for everything that may stream.
   */
  static async instant<T extends keyof GetRPC>(
    path: T,
    ...args: [options?: QueryFacadeOptions<T>]
  ): Promise<Data<T>> {
    const entry = Query.ensure(path, args[0]);
    await entry.promise;
    if (entry.status === "rejected") {
      throw entry.error;
    }
    return entry.data as Data<T>;
  }

  /**
   * Start the query now, in parallel with everything else this request does,
   * without blocking the response on it. A `useQuery` for the same path and
   * search renders with this data the moment it lands — in the document
   * payload when it wins the render, streamed into the page when it doesn't.
   */
  static prefetch<T extends keyof GetRPC>(
    path: T,
    ...args: [options?: QueryFacadeOptions<T>]
  ) {
    Query.ensure(path, args[0]);
  }

  /**
   * Declare that this route primes nothing on purpose, silencing the dev-mode
   * late-discovery hints for the request. Priming is not free — prefetched
   * data is re-fetched and streamed into every client-navigation payload for
   * the route, even when the client already holds it — so a handler that
   * deliberately leaves a heavy query to `useQuery`'s cache-then-revalidate
   * can say so instead of being nagged.
   */
  static noPrefetch() {
    const ctx = RequestContext.getStore();

    if (ctx.req.kind === "api") {
      throw new Error("Query.noPrefetch() cannot be called from an API request");
    }

    ctx.serverQueries ??= new ServerQueryStore(
      createServerQueryFetcher(ctx.req.rawRequest),
    );
    ctx.serverQueries.muteDiscoveryHints();
  }

  /**
   * Hands the page a query's answer that the handler already has: the client's
   * `useQuery(path, { params, search })` with the same key renders it during
   * SSR and hydrates it into the cache, with no request. The route's handler
   * is not run, so the data is whatever the caller resolved, under its own
   * access rules. Later refetches go to the route as usual.
   *
   * Per request: the data lives in this request's store only.
   */
  static prefill<T extends keyof GetRPC>(
    path: T,
    options: QueryFacadeOptions<T>,
    data: Data<T>,
  ) {
    const ctx = RequestContext.getStore();

    if (ctx.req.kind === "api") {
      throw new Error("Query.prefill() cannot be called from an API request");
    }

    ctx.serverQueries ??= new ServerQueryStore(
      createServerQueryFetcher(ctx.req.rawRequest),
    );
    ctx.serverQueries.prefill(path, options, data);
  }

  /**
   * Names the queries this request changed. The answer carries them in a
   * header and the client's mutation hooks refetch every mounted query that
   * matches; a cached one that is not on screen is marked stale.
   *
   * A key is a query's path, with its params applied: `"/posts"` is every
   * search variant of that path, `"/posts?status=open"` that variant alone,
   * and a trailing `*` matches by prefix (`"/posts/*"`).
   */
  static invalidate(...keys: InvalidationKey[]) {
    const ctx = RequestContext.getStore();
    const named = decodeInvalidationKeys(ctx.headers.get(INVALIDATE_HEADER));
    ctx.setHeaders(INVALIDATE_HEADER, encodeInvalidationKeys([...named, ...keys]));
  }
}
