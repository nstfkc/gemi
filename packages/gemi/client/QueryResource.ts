import { Subject } from "../utils/Subject";
import { QueryError } from "./QueryError";

type State = {
  loading: boolean;
  data: any;
  error: any;
  version: number;
};

type Deferred = { promise: Promise<void>; resolve: () => void };

export const DEFAULT_STALE_TIME = 5000;

export class QueryResource {
  store: Subject<Map<string, State>>;
  staleVariants = new Set<string>();
  lastFetchRecord = new Map<string, number>();
  key: string;
  /**
   * Variants with a request on the wire. React discards and retries a
   * suspended render, so `read` runs many times for one commit — this is what
   * collapses those attempts onto a single fetch. The `loading` flag can't do
   * it: render-initiated fetches are silent and never write to the store.
   */
  private inflight = new Set<string>();
  /**
   * One promise per suspended variant, handed to `use()`. Settled by whatever
   * write lands first — the variant's own fetch or a `hydrate` from a route
   * payload — so a prefetch that arrives mid-suspension wakes the reader
   * without waiting on the wire.
   */
  private pending = new Map<string, Deferred>();

  constructor(key: string, initialState: Record<string, any>) {
    this.key = key;
    this.store = new Subject(new Map());
    this.hydrate(initialState);
  }

  /**
   * Adopt server-prefetched data into the cache.
   *
   * Called once from the constructor for the SSR payload, and again on every
   * client-side navigation with the `prefetchedData` the server just produced —
   * otherwise the resource cache (which is keyed by path for the lifetime of
   * the app) would keep serving the first payload and revalidate it over `/api`.
   */
  hydrate(initialState: Record<string, any> | null | undefined) {
    const store = this.store.getValue();
    const now = Date.now();
    let changed = false;

    for (const [variantKey, data] of Object.entries(initialState ?? {})) {
      if (!data) continue;
      const current = store.get(variantKey);
      // Never clobber an in-flight fetch — `resolveVariant` flips `loading`
      // before its first await, so this also covers an optimistic `mutate`
      // whose refetch hasn't landed yet.
      if (current?.loading) continue;
      // Idempotent re-hydration (e.g. StrictMode's double invoke).
      if (current && current.data === data) continue;

      store.set(variantKey, {
        loading: false,
        data,
        error: null,
        version: now,
      });
      this.staleVariants.delete(variantKey);
      this.lastFetchRecord.set(variantKey, now);
      // Wake a reader suspended on this variant — the payload the server just
      // shipped is the answer it was waiting on.
      this.settle(variantKey);
      changed = true;
    }

    if (changed) {
      this.store.next(store);
    }
  }

  private pendingFor(variantKey: string): Deferred {
    let deferred = this.pending.get(variantKey);
    if (!deferred) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      deferred = { promise, resolve };
      this.pending.set(variantKey, deferred);
    }
    return deferred;
  }

  private settle(variantKey: string) {
    const deferred = this.pending.get(variantKey);
    if (deferred) {
      this.pending.delete(variantKey);
      deferred.resolve();
    }
  }

  private isStale(variantKey: string, staleTime: number) {
    if (this.staleVariants.has(variantKey)) return true;
    const now = Date.now();
    // `>=` so `staleTime: 0` means "always revalidate" and
    // `staleTime: Infinity` means "never".
    return now - (this.lastFetchRecord.get(variantKey) ?? now) >= staleTime;
  }

  /**
   * The cached state for a variant, or `undefined` — a plain read that never
   * fetches and never revalidates.
   *
   * `getVariant` is the read that keeps the cache honest, and it starts a
   * request when it has to. That makes it the wrong thing to call while
   * rendering: React throws away a render whose subtree suspends and retries
   * it, so every discarded attempt would leak a request. Renders read with
   * this; effects, which only run for a render that committed, use
   * `getVariant`.
   */
  peek(variantKey: string) {
    return this.store.getValue().get(variantKey);
  }

  /**
   * The read a render performs. Never suspends when data is in hand (stale
   * data revalidates in the background instead), dedupes across the render
   * attempts React throws away, and hands back a promise that resolves off
   * any write to the variant — its own fetch or a `hydrate`.
   *
   * Safe during render: it never writes to the store synchronously, so the
   * snapshot `useSyncExternalStore` read stays valid for the whole attempt.
   */
  read(
    variantKey: string,
    staleTime: number = DEFAULT_STALE_TIME,
  ): { state?: State; promise?: Promise<void> } {
    const state = this.peek(variantKey);

    // Data in hand: stale-while-revalidate, never suspend.
    if (state?.data) {
      if (
        !this.inflight.has(variantKey) &&
        this.isStale(variantKey, staleTime)
      ) {
        this.lastFetchRecord.set(variantKey, Date.now());
        this.resolveVariant(variantKey, true);
      }
      return { state };
    }
    if (state?.error) {
      // The caller throws it into the nearest error boundary.
      return { state };
    }
    if (typeof window === "undefined") {
      // SSR never fetches and never suspends; the server renders whatever the
      // prefetch payload seeded.
      return { state };
    }

    const deferred = this.pendingFor(variantKey);
    if (!this.inflight.has(variantKey)) {
      this.resolveVariant(variantKey, true);
    }
    return { state, promise: deferred.promise };
  }

  getVariant(variantKey: string, staleTime: number = DEFAULT_STALE_TIME) {
    const store = this.store.getValue();
    if (!store.has(variantKey)) {
      // Join a render-initiated fetch instead of racing it — silent reads
      // never flip `loading`, so the flag alone can't dedupe here.
      if (!this.inflight.has(variantKey)) {
        this.resolveVariant(variantKey);
      }
    } else {
      const variant = store.get(variantKey);

      if (!variant.loading && !this.inflight.has(variantKey)) {
        // Don't have data
        if (!variant.data) {
          this.resolveVariant(variantKey);
          return store.get(variantKey);
        }
        if (variant.data) {
          if (this.isStale(variantKey, staleTime)) {
            this.lastFetchRecord.set(variantKey, Date.now());
            this.resolveVariant(variantKey, true);
            return store.get(variantKey);
          }
        }
      }
    }
    return store.get(variantKey);
  }

  /**
   * Drop the error for one variant (or every variant when omitted), so an
   * error boundary reset re-renders into a clean read instead of instantly
   * re-throwing the stored failure.
   */
  clearError(variantKey?: string) {
    const store = this.store.getValue();
    let changed = false;
    for (const [key, state] of store) {
      if (variantKey !== undefined && key !== variantKey) continue;
      if (state.error) {
        store.set(key, { ...state, error: null });
        changed = true;
      }
    }
    if (changed) {
      this.store.next(store);
    }
  }

  mutate(variantKey: string, fn: (data: any) => any = (data) => data) {
    const cacheKey = [
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "",
      this.key,
      variantKey,
    ]
      .filter((s) => s.length > 0)
      .join("?");
    try {
      if (caches) {
        caches?.delete(cacheKey);
      }
    } catch (err) {}

    const store = this.store.getValue();
    const state = store.get(variantKey);
    if (!state || !state.data) {
      // Nothing is cached yet to update optimistically — e.g. a lazy query, or
      // one that hasn't resolved. Fall through to a refetch so `mutate(fn)` is
      // not a silent no-op (it still means "go get the latest data").
      this.resolveVariant(variantKey, false, false);
      return;
    }
    const data = fn(state.data);

    this.staleVariants.add(variantKey);
    this.store.next(
      store.set(variantKey, {
        loading: false,
        data,
        error: null,
        version: state.version,
      }),
    );
    this.resolveVariant(variantKey, false, false);
  }

  refetch(variantKey: string) {
    this.resolveVariant(variantKey, false, false);
  }

  private async resolveVariant(
    variantKey: string,
    silent = false,
    cache = true,
  ) {
    if (typeof window === "undefined") {
      return;
    }
    // Synchronous with the call, so every read in the same render pass sees
    // the request as already on the wire.
    this.inflight.add(variantKey);
    try {
      const store = this.store.getValue();
      const previousState = store.get(variantKey);

      if (!silent) {
        store.set(variantKey, {
          loading: true,
          data: previousState?.data,
          error: previousState?.error,
          version: previousState?.version,
        });
      }

      let data = null;
      let response: Response | null = null;
      const fullUrl = [this.key, variantKey].filter((s) => s.length).join("?");
      try {
        response = await fetch(`/api${fullUrl}`, {
          cache: cache ? "default" : "reload",
        });
        data = await response.json();
      } catch (error) {
        console.error(`Error fetching url /api${fullUrl}`, error);
        this.store.next(
          store.set(variantKey, {
            loading: false,
            data: previousState?.data,
            error,
            version: previousState?.version,
          }),
        );
        return;
      }

      if (response!.ok) {
        this.store.next(
          store.set(variantKey, {
            loading: false,
            data,
            error: null,
            version: Date.now(),
          }),
        );
        this.staleVariants.delete(variantKey);
        this.lastFetchRecord.set(variantKey, Date.now());
      } else {
        // this.lastFetchRecord.set(variantKey, 0);
        this.store.next(
          store.set(variantKey, {
            loading: false,
            data: previousState?.data,
            error: new QueryError(this.key, variantKey, response!.status, data),
            version: previousState?.version,
          }),
        );
      }
    } finally {
      this.inflight.delete(variantKey);
      // Settle on failure too — a suspended reader has to wake up to throw.
      this.settle(variantKey);
    }
  }
}
