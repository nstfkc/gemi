import { applyParams } from "../../utils/applyParams";
import { omitNullishValues } from "../../utils/omitNullishValues";

export type ServerQueryOptions = {
  params?: Record<string, any>;
  search?: Record<string, string | number | boolean | null>;
};

export type ServerQuerySource = "prefetch" | "render";

export interface ServerQueryEntry {
  /** Concrete path, params applied — `/posts/123`, not `/posts/:id`. */
  path: string;
  /** Sorted search params — the same variant key `useQuery` derives. */
  variantKey: string;
  status: "pending" | "resolved" | "rejected";
  data?: any;
  error?: any;
  /**
   * Settles (always resolves, never rejects — a rejection would surface as an
   * unhandled rejection in every render attempt React discards) only after the
   * result is recorded AND the settle listener has run. A suspended server
   * render woken by this promise can therefore rely on the entry's data being
   * readable and its payload script being queued ahead of React's own chunks.
   */
  promise: Promise<void>;
  source: ServerQuerySource;
  /** ms since the request started. */
  startedAt: number;
  settledAt?: number;
}

export type ServerQueryFetcher = (
  patternPath: string,
  params: Record<string, any>,
  searchParams: URLSearchParams,
) => Promise<any>;

/**
 * When a render-discovered query starts this long after the render began, it
 * was blocked behind another suspended segment (or conditional data) — the
 * fetch that could have been overlapping wasn't. Anything under this is just
 * first-pass discovery, which needs no declaration.
 */
const LATE_DISCOVERY_THRESHOLD_MS = 50;

/**
 * Per-request registry of every server-side query — the streaming-SSR twin of
 * the client's `QueryResource`.
 *
 * Fetches decouple from render: `Query.prefetch` starts its request the
 * moment it is called (in the route handler, before any rendering), and a
 * `useQuery` the render discovers starts one on the spot. Every entry is
 * inflight-deduped by path + variant, so the request total is always
 * `max(query times)`, never a sum — a suspended layout does not delay the
 * fetch of the leaf below it.
 */
export class ServerQueryStore {
  private entries = new Map<string, ServerQueryEntry>();
  private settleListener: ((entry: ServerQueryEntry) => void) | null = null;
  /** Entries settled before the stream injector subscribed. */
  private settledBacklog: ServerQueryEntry[] = [];
  /** Variants already serialized into `__GEMI_DATA__` — not streamed again. */
  private shipped = new Set<string>();
  private requestStartedAt = performance.now();
  private renderStartedAt: number | null = null;

  constructor(private fetcher: ServerQueryFetcher) {}

  private elapsed() {
    return Math.round(performance.now() - this.requestStartedAt);
  }

  private keyFor(path: string, variantKey: string) {
    return [path, variantKey].filter((s) => s.length > 0).join("?");
  }

  /** Marks the point streaming render begins — the late-discovery baseline. */
  markRenderStart() {
    if (this.renderStartedAt === null) {
      this.renderStartedAt = performance.now();
    }
  }

  read(path: string, variantKey: string): ServerQueryEntry | undefined {
    return this.entries.get(this.keyFor(path, variantKey));
  }

  /**
   * The single entry point for starting (or joining) a server-side query.
   * Callable from the route-handler phase (`Query.prefetch` / `Query.instant`)
   * and from the render phase (`useQuery` on the server) — React discards and
   * retries suspended renders, so idempotence per path + variant is load-bearing.
   */
  ensure(
    patternPath: string,
    options: ServerQueryOptions = {},
    source: ServerQuerySource = "render",
  ): ServerQueryEntry {
    const params = options.params ?? {};
    const searchParams = new URLSearchParams(
      omitNullishValues((options.search ?? {}) as Record<string, string>),
    );
    searchParams.delete("json");
    searchParams.sort();

    const path = applyParams(patternPath, params);
    const variantKey = searchParams.toString();
    const key = this.keyFor(path, variantKey);

    const existing = this.entries.get(key);
    if (existing) return existing;

    if (
      source === "render" &&
      this.renderStartedAt !== null &&
      process.env.NODE_ENV !== "production"
    ) {
      const delay = Math.round(performance.now() - this.renderStartedAt);
      if (delay > LATE_DISCOVERY_THRESHOLD_MS) {
        const searchHint = variantKey
          ? `, { search: ${JSON.stringify(Object.fromEntries(searchParams))} }`
          : "";
        console.warn(
          `[gemi] useQuery("${patternPath}") started ${delay}ms into the server render — ` +
            `it was discovered under a suspended segment, so its fetch could not overlap ` +
            `the others. It still streams, but \`Query.prefetch("${patternPath}"${searchHint})\` ` +
            `in the route's view handler would start it at request time.`,
        );
      }
    }

    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const entry: ServerQueryEntry = {
      path,
      variantKey,
      status: "pending",
      promise,
      source,
      startedAt: this.elapsed(),
    };
    this.entries.set(key, entry);

    this.fetcher(patternPath, params, searchParams)
      .then(
        (data) => {
          entry.status = "resolved";
          entry.data = data;
        },
        (error) => {
          entry.status = "rejected";
          entry.error = error;
        },
      )
      .then(() => {
        entry.settledAt = this.elapsed();
        // Listener first, wake second: the payload script must be queued for
        // injection before React resumes the suspended segment, so the data
        // always precedes the segment's reveal in the stream.
        if (this.settleListener) {
          this.settleListener(entry);
        } else {
          this.settledBacklog.push(entry);
        }
        settle();
      });

    return entry;
  }

  /**
   * Everything currently registered, settled — including entries added while
   * waiting. The non-streaming paths (`.json` route data responses) sit on
   * this to keep their all-data-in-one-payload contract.
   */
  async allSettled(): Promise<void> {
    let count = 0;
    while (count !== this.entries.size) {
      count = this.entries.size;
      await Promise.all(Array.from(this.entries.values(), (e) => e.promise));
    }
  }

  /**
   * Resolved data in `prefetchedData` shape — `{ path: { variantKey: data } }`.
   * Marks what it returns as shipped so the stream injector skips it.
   */
  snapshotResolved(): Record<string, Record<string, any>> {
    const snapshot: Record<string, Record<string, any>> = {};
    for (const [key, entry] of this.entries) {
      if (entry.status !== "resolved") continue;
      this.shipped.add(key);
      snapshot[entry.path] ??= {};
      snapshot[entry.path][entry.variantKey] = entry.data;
    }
    return snapshot;
  }

  /**
   * Single-subscriber settle feed for the stream injector. Entries that
   * settled before subscription are replayed, minus anything a snapshot
   * already shipped.
   */
  onSettle(listener: (entry: ServerQueryEntry) => void) {
    this.settleListener = (entry) => {
      if (this.shipped.has(this.keyFor(entry.path, entry.variantKey))) return;
      listener(entry);
    };
    const backlog = this.settledBacklog;
    this.settledBacklog = [];
    for (const entry of backlog) {
      this.settleListener(entry);
    }
  }
}
