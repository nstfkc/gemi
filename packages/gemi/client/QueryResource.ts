import { Subject } from "../utils/Subject";

type State = {
  loading: boolean;
  data: any;
  error: any;
  version: number;
};

export const DEFAULT_STALE_TIME = 5000;

export class QueryResource {
  store: Subject<Map<string, State>>;
  staleVariants = new Set<string>();
  lastFetchRecord = new Map<string, number>();
  key: string;

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
      changed = true;
    }

    if (changed) {
      this.store.next(store);
    }
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

  getVariant(variantKey: string, staleTime: number = DEFAULT_STALE_TIME) {
    const store = this.store.getValue();
    if (!store.has(variantKey)) {
      this.resolveVariant(variantKey);
    } else {
      const variant = store.get(variantKey);

      if (!variant.loading) {
        // Don't have data
        if (!variant.data) {
          this.resolveVariant(variantKey);
          return store.get(variantKey);
        }
        if (variant.data) {
          const stale = this.staleVariants.has(variantKey);
          const now = Date.now();
          // `>=` so `staleTime: 0` means "always revalidate" and
          // `staleTime: Infinity` means "never".
          const old =
            now - (this.lastFetchRecord.get(variantKey) ?? now) >= staleTime;
          if (stale || old) {
            this.lastFetchRecord.set(variantKey, now);
            this.resolveVariant(variantKey, true);
            return store.get(variantKey);
          }
        }
      }
    }
    return store.get(variantKey);
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
          error: data,
          version: previousState?.version,
        }),
      );
    }
  }
}
