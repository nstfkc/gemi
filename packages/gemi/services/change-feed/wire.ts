import type { ChangeFeedEvent } from "./ChangeFeedDriver";

// What crosses the wire between `ChangeFeed.stream` and `useSubscription`.
// Kept free of runtime imports so the browser build can name it.

declare const changeFeedData: unique symbol;

/**
 * The `Response` `ChangeFeed.stream` returns. `T` is the type of the
 * published `data`, carried only in the type so `useSubscription` can infer
 * it from the route.
 */
export type ChangeFeedResponse<T = unknown> = Response & { readonly [changeFeedData]?: T };

/**
 * What a stream sends, one per SSE event. `ready` comes first, once the
 * subscription knows where it is; its `id` is the cursor to resume from even
 * if nothing changes before the connection drops.
 */
export type ChangeFeedMessage<T = unknown> = ChangeFeedEvent<T> | { type: "ready" };

