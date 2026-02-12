import { Subject } from "../utils/Subject";

type State = {
  loading: boolean;
  data: any;
  error: any;
  version: number;
};

export class QueryResource {
  store: Subject<Map<string, State>>;
  staleVariants = new Set<string>();
  lastFetchRecord = new Map<string, number>();
  key: string;

  constructor(key: string, initialState: Record<string, any>) {
    this.key = key;
    const store = new Map();
    const now = Date.now();
    for (const [variantKey, data] of Object.entries(initialState ?? {})) {
      if (data) {
        store.set(variantKey, {
          loading: false,
          data,
          error: null,
        });
        this.lastFetchRecord.set(variantKey, now);
      }
    }

    this.store = new Subject(store);
  }

  getVariant(variantKey: string) {
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
          //
        }
        if (variant.data) {
          const stale = this.staleVariants.has(variantKey);
          const now = Date.now();
          // TODO: age must be dynamic
          const old =
            now - (this.lastFetchRecord.get(variantKey) ?? now) > 5000;
          if (stale || old) {
            this.lastFetchRecord.set(variantKey, now);
            this.resolveVariant(variantKey, true);
            return store.get(variantKey);
            //
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
        error: previousState?.data,
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
    }

    if (response.ok) {
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
