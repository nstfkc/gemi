/**
 * What a lazy `import()` resolved to, or a thrown error when it is missing.
 * Vite's preload helper resolves the `import()` to `undefined` instead of
 * rejecting when a `vite:preloadError` listener handled the failure (`init`'s
 * chunk-load recovery does, as it starts a reload): treated as a failed load.
 */
export function loadedModule<T>(module: T | undefined): T {
  if (!module) throw new Error("[gemi] A lazily loaded chunk is unavailable.");
  return module;
}

/**
 * A module of `gemi/client` loaded with `import()` on first use (#891,
 * #915). An app's bundler places a module by what reaches it statically, and
 * every route's entry chunk reaches all of `gemi/client`, so code that only
 * some pages need stays out of the entry this way.
 *
 * `current` is the module once it has loaded, for callers that must not wait
 * when it is there; `load` is replaceable in tests. Declared as an object
 * literal, never through a call: an app's bundler drops an unused literal and
 * its `import()` with it, while an unused call's `import()` can still emit an
 * orphaned chunk that changes how the app is split.
 */
export interface LazyModule<M> {
  current: M | null;
  load: () => Promise<M | undefined>;
  /** The load in flight, shared by every caller until it settles. */
  loading?: Promise<M> | null;
}

/**
 * The module, loading it if it is not there yet. Callers while it loads share
 * one load, so their callbacks run in call order. A failed load is not kept:
 * the next call runs `import()` again.
 */
export function loadLazy<M>(lazy: LazyModule<M>): Promise<M> {
  if (lazy.current) return Promise.resolve(lazy.current);
  return (lazy.loading ??= lazy.load().then(
    (module) => {
      lazy.loading = null;
      return (lazy.current = loadedModule(module));
    },
    (error: unknown) => {
      lazy.loading = null;
      throw error;
    },
  ));
}
