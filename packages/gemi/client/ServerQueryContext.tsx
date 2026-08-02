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
  ensure(
    path: string,
    options?: {
      params?: Record<string, any>;
      search?: Record<string, string | number | boolean | null>;
    },
    source?: "prefetch" | "render",
  ): ServerQueryEntryLike;
}

/**
 * Populated only during a streaming server render (`createRoot` threads the
 * request's store through); always `null` in the browser, where suspension
 * runs on `QueryResource` instead.
 */
export const ServerQueryContext = createContext<ServerQueriesLike | null>(null);
