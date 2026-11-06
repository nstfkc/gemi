import { createContext } from "react";

/**
 * The structural slice of the server's `ServerQueryStore` that `useQuery`
 * needs during a streaming server render. Declared here — not imported from
 * `services/router` — because this file ships in the browser bundle; only the
 * shape crosses over, never the implementation.
 */
export interface ServerQueryEntryLike {
  status: "pending" | "resolved" | "rejected";
  data?: any;
  error?: any;
  promise: Promise<void>;
}

export interface ServerQueriesLike {
  /**
   * The query's entry, started or joined. `null` when this store does not
   * serve the query: an island on a static page only reads what the request
   * prefetched (#1155), and renders any other query as it would with no store.
   */
  ensure(
    path: string,
    options?: {
      params?: Record<string, any>;
      search?: Record<string, string | number | boolean | null>;
    },
    source?: "prefetch" | "render",
  ): ServerQueryEntryLike | null;
}

/**
 * Populated only during a server render (`createRoot` threads the request's
 * store through, and a static view gives each island's root a view of it);
 * always `null` in the browser, where suspension runs on `QueryResource`
 * instead.
 */
export const ServerQueryContext = createContext<ServerQueriesLike | null>(null);
