import type { QueryResource } from "./QueryResource";
import { isPlainObject } from "./isPlainObject";
import { applyParams } from "../utils/applyParams";
import { toVariantKey } from "../utils/variantKey";
import {
  retryDelayFor,
  shouldRetryQuery,
  type QueryFailure,
  type RetryDelayOption,
  type RetryOption,
} from "./retryPolicy";

/**
 * The per-query work `useQuery` and `useMultipleQuery` share, as plain
 * functions: `useQuery` runs each one from its own effect for its one query,
 * `useMultipleQuery` runs it once per key from a single effect. Keeping the
 * bodies here is what stops the two hooks from drifting apart.
 */

/** The config keys these helpers read. */
export interface QueryEffectConfig {
  retry?: RetryOption;
  retryDelay?: RetryDelayOption;
  retryIntervalOnError?: number;
  staleTime?: number;
  focusThrottleInterval?: number;
  debug?: boolean;
}

type Snapshot = ReturnType<QueryResource["peek"]>;

/**
 * Where a query reads from: the resolved path (route params from the URL,
 * overridden by `options.params`) and the variant key of its `search`.
 */
export function resolveQueryTarget(
  url: string,
  options: { params?: Record<string, any>; search?: Record<string, any> | null },
  routeParams: Record<string, any>,
) {
  const params =
    "params" in options ? { ...routeParams, ...options.params } : routeParams;
  const search = "search" in options ? (options.search ?? {}) : {};
  return {
    params,
    search,
    path: applyParams(url, params),
    variantKey: toVariantKey(search),
  };
}

/**
 * Per-call config over the provider's `queryConfig`. Only *defined* per-call
 * keys participate: a key explicitly set to `undefined` (`{ suspense: cond ?
 * true : undefined }`, forwarding an optional prop) falls through to the
 * provider default instead of clobbering it.
 */
export function mergeDefinedConfig<C extends object>(
  base: C,
  ...overrides: Array<Partial<C> | null | undefined>
): C {
  const merged = { ...base } as Record<string, unknown>;
  for (const override of overrides) {
    if (!override) continue;
    for (const key of Object.keys(override)) {
      const value = (override as Record<string, unknown>)[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as C;
}

/**
 * A failed `suspense: false` query: schedule the background retry its retry
 * policy allows. The resource owns the timer, one per variant however many
 * readers render it.
 */
export function retryFailedQuery(
  resource: QueryResource,
  variantKey: string,
  snapshot: Snapshot,
  cfg: QueryEffectConfig,
) {
  if (!snapshot?.error || snapshot.loading) return;
  const error = snapshot.error as QueryFailure;
  const failureCount = Math.max(1, resource.failureCount(variantKey));
  if (!shouldRetryQuery(failureCount, error, cfg.retry)) return;
  const delay = retryDelayFor(
    failureCount,
    error,
    cfg.retryDelay,
    cfg.retryIntervalOnError,
  );
  if (cfg.debug) console.log("retrying", variantKey, "in", delay);
  resource.scheduleRetry(variantKey, delay);
}

/**
 * Coming back online retries a query that failed in a way another attempt
 * might fix, as long as its retry policy would retry that error at all.
 * Silent, and it starts a fresh run of failures. Returns the cleanup.
 */
export function retryWhenOnline(
  resource: QueryResource,
  variantKey: string,
  getConfig: () => QueryEffectConfig,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => {
    const state = resource.peek(variantKey);
    if (!state?.error) return;
    if (!shouldRetryQuery(1, state.error, getConfig().retry)) return;
    resource.retryNow(variantKey);
  };
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}

/** `refetchUntil`'s poll for one query. */
export interface PollState {
  timer: ReturnType<typeof setTimeout> | null;
  /** The delay `refetchUntil` returned last, handed back as `duration`. */
  duration: number;
  snapshot: unknown;
  resource: unknown;
  variantKey: string | null;
  /** The poll's own refetch is on the wire. */
  awaiting: boolean;
}

export function createPollState(): PollState {
  return {
    timer: null,
    duration: 0,
    snapshot: undefined,
    resource: null,
    variantKey: null,
    awaiting: false,
  };
}

/**
 * One step of the `refetchUntil` poll, run after every commit so the
 * predicate always sees the current render's closure. New data (or another
 * resource/variant) clears the pending timer and asks the predicate again; on
 * a plain re-render a pending timer is kept, so frequent renders never push
 * the next refetch back. `paused` (a live channel is open) stops it.
 */
export function stepPoll(
  poll: PollState,
  resource: QueryResource,
  variantKey: string,
  snapshot: Snapshot,
  refetchUntil: ((data: any, duration: number) => number) | undefined,
  paused: boolean,
) {
  const clear = () => {
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = null;
  };
  if (
    poll.snapshot !== snapshot ||
    poll.resource !== resource ||
    poll.variantKey !== variantKey
  ) {
    clear();
    poll.awaiting = false;
    poll.snapshot = snapshot;
    poll.resource = resource;
    poll.variantKey = variantKey;
  }
  if (
    !refetchUntil ||
    paused ||
    !snapshot ||
    snapshot.loading ||
    !snapshot.hasData ||
    snapshot.error
  ) {
    clear();
    return;
  }
  // The poll's own refetch is on the wire; its answer re-runs this.
  if (poll.awaiting) return;
  const nextDuration = refetchUntil(snapshot.data, poll.duration);
  if (!(nextDuration > 0)) {
    clear();
    poll.duration = 0;
    return;
  }
  if (poll.timer) return;
  poll.duration = nextDuration;
  poll.timer = setTimeout(() => {
    poll.timer = null;
    poll.awaiting = true;
    resource.refetch(variantKey);
  }, nextDuration);
}

/** Unmount: drop the pending poll. */
export function stopPoll(poll: PollState) {
  if (poll.timer) clearTimeout(poll.timer);
  poll.timer = null;
  // A StrictMode remount re-runs the step with the same snapshot.
  poll.snapshot = undefined;
  poll.awaiting = false;
}

/** The `refreshInterval` / HMR `http-reload` reload of one query. */
export function reloadQuery(
  resource: QueryResource,
  variantKey: string,
  cfg: QueryEffectConfig,
) {
  if (cfg.debug) {
    console.log("Reloading query for", variantKey);
  }
  const data = resource.getVariant(variantKey, cfg.staleTime).data;
  resource.mutate(variantKey, () => data);
}

/** Subscribe to Vite's `http-reload` event. Returns the cleanup. */
export function onHttpReload(handler: () => void): () => void {
  // Feature-checked per method: vitest's `import.meta.hot` shim has `on`
  // but not `off`.
  // @ts-ignore
  if (typeof import.meta.hot?.on === "function") {
    // @ts-ignore
    import.meta.hot.on("http-reload", handler);
  }
  return () => {
    // @ts-ignore
    if (typeof import.meta.hot?.off === "function") {
      // @ts-ignore
      import.meta.hot.off("http-reload", handler);
    }
  };
}

/** The focus-revalidation guards of one query; they outlive effect re-runs. */
export interface FocusState {
  /** Only reads that put data on screen enroll a query (not a hover prefetch). */
  eligible: boolean;
  /** The window really lost focus, or the tab was hidden, since the last one. */
  wasAway: boolean;
  /** When the last focus revalidation went out. */
  last: number;
}

/**
 * Revalidate when the tab comes back to the foreground, gated by `staleTime`
 * and always silent. Three guards decide whether a return is owed a request:
 * eligibility, the away latch (`focus` also fires for a dismissed `alert`),
 * and the throttle (an embedded iframe blurs and focuses the window on every
 * click). Both `focus` and `visibilitychange` are listened for because
 * neither covers the other. Returns the cleanup.
 */
export function revalidateOnFocus(
  resource: QueryResource,
  variantKey: string,
  focus: FocusState,
  getConfig: () => QueryEffectConfig,
): () => void {
  const markAway = () => {
    focus.wasAway = true;
  };
  const revalidate = () => {
    if (!focus.eligible) return;
    if (document.visibilityState === "hidden") return;
    if (!focus.wasAway) return;
    const now = Date.now();
    // Throttled: leave the latch armed so the next return, once the
    // interval has passed, still revalidates.
    if (now - focus.last < (getConfig().focusThrottleInterval ?? 0)) {
      return;
    }
    focus.wasAway = false;
    focus.last = now;
    resource.revalidate(variantKey, getConfig().staleTime);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      markAway();
    } else {
      revalidate();
    }
  };
  window.addEventListener("blur", markAway);
  window.addEventListener("focus", revalidate);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("blur", markAway);
    window.removeEventListener("focus", revalidate);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/**
 * A DOM event or React's synthetic one. Never a plain object, so a cached
 * value that happens to have a `nativeEvent` key is not mistaken for one.
 */
function isEventLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null || isPlainObject(value)) {
    return false;
  }
  if (typeof Event !== "undefined" && value instanceof Event) return true;
  return (
    "nativeEvent" in value &&
    typeof (value as { preventDefault?: unknown }).preventDefault === "function"
  );
}

/**
 * `mutate(value | updater)` for one query; a bare `mutate()` refetches.
 * Returns whether it went to the wire for a refetch (the caller marks the
 * query as fetched).
 */
export function mutateQuery(
  resource: QueryResource,
  variantKey: string,
  fn: unknown,
): "refetch" | "update" {
  // `onClick={mutate}` hands React's event to `mutate` as if it were the
  // new data. An event carries no data to write, so it means what a bare
  // `mutate()` means: refetch.
  if (isEventLike(fn)) fn = undefined;
  if (!fn) {
    resource.refetch(variantKey);
    return "refetch";
  }
  resource.mutate(variantKey, (data: any) => {
    // `null` is a legitimate cached body; only `undefined` means the query
    // hasn't produced anything (and `mutate` refetches instead of calling
    // this in that case).
    if (data === undefined) {
      console.warn("Mutate function called before the query.");
      return data;
    }

    // The callback's return value *replaces* the cached data. The type checks
    // below only ensure the shape matches so a stray value can't corrupt the
    // cache; they do not merge or append.
    const updatedData =
      typeof fn === "function" ? (fn as (d: any) => any)(data) : fn;

    if (isPlainObject(data)) {
      if (isPlainObject(updatedData)) {
        return updatedData;
      }
      throw new Error(
        "Mutate function must return an object when the current data is an object.",
      );
    }

    if (Array.isArray(data)) {
      if (Array.isArray(updatedData)) {
        return updatedData;
      }
      throw new Error(
        "Mutate function must return an array when the current data is an array.",
      );
    }

    if (typeof data !== typeof updatedData) {
      throw new Error(
        "Mutate function must return the same type as the current data.",
      );
    }

    return updatedData;
  });
  return "update";
}

/**
 * The dev warning for a suspense query a server render had no data for.
 */
export function warnUnprefetched(
  url: string,
  variantKey: string,
  hook = "useQuery",
) {
  const searchHint = variantKey
    ? `, { search: ${JSON.stringify(
        Object.fromEntries(new URLSearchParams(variantKey)),
      )} }`
    : "";
  console.warn(
    `[gemi] ${hook}("${url}") rendered on the server without data. ` +
      `The server never fetches, so this page ships without it and the ` +
      `client suspends after hydration. Add ` +
      `\`Query.prefetch("${url}"${searchHint})\` to the route's view handler.`,
  );
}
