/**
 * The process-wide store behind `defineDictionary`.
 *
 * Every handle registers itself here when its module is *evaluated*, not when
 * it is first rendered. That ordering is the whole point: the view router
 * already awaits a view's module import before rendering it, so by the time it
 * calls `preloadDictionaries()` every dictionary reachable from that view has
 * announced itself and can be warmed in one pass. `useDictionary` then reads
 * resolved strings synchronously and the render never suspends — on the server
 * that keeps the SSR stream from fragmenting into a reveal chunk per
 * dictionary, and on the client it keeps navigations flash-free.
 *
 * `use()` in the hook is the correctness net for what a preload pass cannot
 * see: a dictionary inside a `lazy()` subtree, or a locale switch.
 */

import type { LocaleStrings } from "./dictionaryShape";

export type { LocaleStrings };

/**
 * A dictionary's strings as the render path sees them: always a promise, so
 * the caller's `use()` is never conditional, and pre-tagged fulfilled when the
 * strings are already in hand so that promise costs nothing. See
 * `loadDictionaryForRender` and `resolvedThenable`.
 */
export type RenderThenable = Promise<LocaleStrings> & {
  /** Set when the load failed and this settled on no strings instead. */
  degraded?: boolean;
  /**
   * The strings, when they were already in hand as this thenable was made. No
   * render can have suspended on such a thenable, so none can be replayed on
   * it either, and `useDictionary` reads these without calling `use()`.
   */
  inHand?: LocaleStrings;
};

export interface RegisteredDictionary {
  id: string;
  /** Locales this dictionary declares. Empty when it is not known up front. */
  locales: string[];
  load: (locale: string) => Promise<LocaleStrings> | LocaleStrings;
}

interface RegistryState {
  /** Every handle that has been constructed, by id. */
  registry: Map<string, RegisteredDictionary>;
  /** Resolved strings: id -> locale -> strings. */
  resolved: Map<string, Map<string, LocaleStrings>>;
  /** In-flight loads, so N components sharing a dictionary share one request. */
  inFlight: Map<string, Promise<LocaleStrings>>;
  /**
   * What the render path hands `use()`, one per (dictionary, locale) and
   * always a thenable — never the raw strings, even once they are in hand.
   * `loadDictionaryForRender` explains both halves.
   */
  renderThenables: Map<string, RenderThenable>;
  /**
   * Registration order, so `preloadDictionaries` can warm only what a freshly
   * imported module added instead of re-walking every dictionary in the app on
   * every navigation.
   */
  order: string[];
  /**
   * Per locale, how far into `order` an unmarked `preloadDictionaries` has
   * already warmed. Lets the server's per-request call cost O(newly imported)
   * rather than O(every dictionary in the app).
   */
  warmed: Map<string, number>;
  /**
   * The locale currently being rendered, recorded by `useDictionary`. The
   * initial payload is in `__GEMI_DATA__`, but that snapshot is frozen at the
   * first load — after a locale switch it is stale, and the view loader needs
   * to know which locale's chunks to warm.
   */
  activeLocale: string | null;
}

/**
 * Parked on `globalThis` rather than in module scope, because this module gets
 * bundled more than once and the copies have to agree.
 *
 * gemi ships `gemi/client` from one Vite lib build and `gemi/dictionary` from a
 * separate Bun build, an SSR view graph externalizes some gemi subpaths and
 * bundles others, and a dictionary imported by both a view and a controller is
 * evaluated on both sides. Every one of those splits would otherwise produce a
 * second registry: views would register into one Map while the view router
 * preloaded and snapshotted from another, and the hydration payload would come
 * out empty. Module identity is not something this can depend on; a global key
 * is.
 */
const GLOBAL_KEY = "__GEMI_DICTIONARY_REGISTRY__";

const state: RegistryState = ((globalThis as any)[GLOBAL_KEY] ??= {
  registry: new Map(),
  resolved: new Map(),
  inFlight: new Map(),
  renderThenables: new Map(),
  order: [],
  warmed: new Map(),
  activeLocale: null,
});

const { registry, resolved, inFlight, renderThenables, order, warmed } = state;

function cacheKey(id: string, locale: string) {
  return `${id}\0${locale}`;
}

export function registerDictionary(entry: RegisteredDictionary) {
  // A dictionary module can be evaluated twice with the same id — e.g. the
  // Vite-processed copy pulled in by a view and the plain copy a controller
  // imports outside the bundler. Same id means same source literal, so the
  // first registration wins and the duplicate is a no-op rather than a reset
  // that would drop already-resolved strings.
  if (registry.has(entry.id)) {
    return;
  }
  registry.set(entry.id, entry);
  order.push(entry.id);
}

/** A marker for "everything registered so far", for `preloadDictionaries`. */
export function dictionaryRegistrationMark(): number {
  return order.length;
}

export function getResolved(
  id: string,
  locale: string,
): LocaleStrings | undefined {
  return resolved.get(id)?.get(locale);
}

function putResolved(id: string, locale: string, strings: LocaleStrings) {
  let byLocale = resolved.get(id);
  if (!byLocale) {
    byLocale = new Map();
    resolved.set(id, byLocale);
  }
  byLocale.set(locale, strings);
}

/**
 * Load one dictionary's locale, de-duplicating concurrent callers. Returns the
 * strings directly (not a promise) when they are already resolved, so the hook
 * can take a synchronous path without a microtask hop.
 */
export function loadDictionary(
  id: string,
  locale: string,
): LocaleStrings | Promise<LocaleStrings> {
  const already = getResolved(id, locale);
  if (already) {
    return already;
  }

  const key = cacheKey(id, locale);
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const entry = registry.get(id);
  if (!entry) {
    throw new Error(
      `Unknown dictionary "${id}". A dictionary must be created with defineDictionary() and its module must have been evaluated before it is read.`,
    );
  }

  const result = entry.load(locale);

  // The untransformed path holds every locale in memory and answers
  // synchronously — no reason to make callers await a resolved promise.
  if (!(result instanceof Promise)) {
    putResolved(id, locale, result);
    return result;
  }

  const promise = result.then(
    (strings) => {
      putResolved(id, locale, strings);
      inFlight.delete(key);
      return strings;
    },
    (err) => {
      inFlight.delete(key);
      throw err;
    },
  );
  inFlight.set(key, promise);
  return promise;
}

/**
 * The same load, but as the exact thing React's `use()` wants.
 *
 * Three properties, each of which has cost a bug:
 *
 * **It never rejects.** A rejecting promise passed to `use()` rethrows during
 * render, which unmounts the whole route into its error boundary — or, before
 * the shell is ready, fails the server render outright. A missing locale chunk
 * is a routine event (a browser holding stale HTML after a rolling deploy
 * requests a hashed filename that no longer exists), and the deprecated
 * `useTranslator` degraded every i18n failure to rendering the raw key. This
 * keeps that behaviour: the thenable resolves to no strings, and the per-key
 * lookup in `useDictionary` then logs and falls back to the key.
 *
 * **It is always a thenable**, even when the strings are already resolved and
 * could be returned raw. Returning them raw is what made #494: the caller's
 * `use()` becomes conditional, and a component whose first pass suspended in
 * `use()` on a cold chunk gets *replayed* by React once that chunk lands
 * mid-yield. React only restores the mount hook dispatcher from inside `use()`
 * itself, so a replay that skips `use()` runs the rest of the component under
 * the update dispatcher against an empty hook list, and the next `useState`
 * throws "Update hook called on initial render". A thenable pre-tagged
 * `fulfilled` costs nothing — React reads it synchronously, no suspend, no
 * microtask hop — and keeps `use()` on every path that can be replayed.
 *
 * **But only those paths call `use()` (#542).** Under `act`, any `use()` call
 * flags the render as waiting on a promise, fulfilled or not, and `act` then
 * parks the render task. When the same component really suspends by *throwing*
 * — as `useQuery` does — that task never runs again and the component never
 * commits. A thenable made from strings already in hand carries them as
 * `inHand`: nothing ever suspended on it, so there is nothing to replay, and
 * the hook reads them directly.
 *
 * **There is exactly one per (dictionary, locale).** React tracks the thenable
 * a component suspended on by position, and a later pass arriving at the same
 * position with a different object gets "A component was suspended by an
 * uncached promise" — and, for a promise that has not settled, would suspend
 * forever on a fresh one every render.
 */
export function loadDictionaryForRender(
  id: string,
  locale: string,
): RenderThenable {
  const key = cacheKey(id, locale);
  const already = getResolved(id, locale);
  const cached = renderThenables.get(key);

  // The cached thenable wins even once the strings are in hand, because it is
  // the object React tracked when the component suspended. The one exception
  // is a thenable that degraded to no strings: it must not shadow a load that
  // later succeeded — a chunk restored after a rolling deploy, which
  // `preloadDictionaries` picks up on the next navigation. Swapping the object
  // is the lesser problem there, and only the failing render pays for it.
  if (cached && !(cached.degraded && already)) {
    return cached;
  }

  if (already) {
    // Not `inHand` when it replaces a degraded thenable: a render may have
    // suspended on that one, and its replay has to reach `use()` again.
    return remember(key, resolvedThenable(already, !cached));
  }

  const result = loadDictionary(id, locale);
  // The untransformed path holds every locale in memory and answers
  // synchronously. It still goes out as a thenable — see above.
  if (!(result instanceof Promise)) {
    return remember(key, resolvedThenable(result, true));
  }

  const safe: RenderThenable = result.then(
    (strings) => strings,
    (err) => {
      console.error(
        `Failed to load dictionary ${id} for locale ${locale}; rendering keys instead.`,
        err,
      );
      safe.degraded = true;
      return EMPTY_STRINGS;
    },
  );
  return remember(key, safe);
}

function remember(key: string, thenable: RenderThenable): RenderThenable {
  renderThenables.set(key, thenable);
  return thenable;
}

/**
 * Strings in hand, as something `use()` can read without suspending.
 *
 * The `status`/`value` pair is React's own thenable tagging, not an invention
 * here: `trackUsedThenable` returns `value` on the spot for a thenable already
 * marked fulfilled, and only subscribes when it is not. Untagged, this would
 * be a plain resolved promise — which suspends the component for a microtask
 * and costs it a second render pass, exactly what the synchronous return this
 * replaces existed to avoid. The properties are absent from `Promise`, and so
 * from `RenderThenable`, because nothing here reads them back; React does.
 */
function resolvedThenable(
  strings: LocaleStrings,
  inHand: boolean,
): RenderThenable {
  return Object.assign(Promise.resolve(strings), {
    status: "fulfilled",
    value: strings,
    inHand: inHand ? strings : undefined,
  });
}

const EMPTY_STRINGS: LocaleStrings = {};

/**
 * Warm dictionaries for `locale`, so a subsequent render reads them
 * synchronously instead of suspending.
 *
 * With a `mark` — the value taken *before* importing a view module — only that
 * view's newly announced dictionaries are loaded. That is the client's use: it
 * knows exactly which chunk just arrived.
 *
 * Without one, it resumes from where this locale last got to. The server calls
 * it per request and has no mark to give (view modules were imported long
 * before the request arrived), so a plain scan from zero would walk every
 * dictionary in the app on every request — re-deriving the per-request cost this
 * whole change exists to remove, just with a smaller constant.
 *
 * An empty `locale` means the app configured none, and each dictionary is warmed
 * under its own source language — the same key `useDictionary` will ask for, so
 * the warmed entry is the one the render actually reads.
 *
 * Failures are swallowed: a dictionary that cannot load should surface at the
 * component that actually reads it, where the error names the key, rather than
 * take down an unrelated navigation.
 */
export async function preloadDictionaries(locale: string, mark?: number) {
  const from = mark ?? warmed.get(locale) ?? 0;
  const ids = order.slice(from);
  if (ids.length === 0) {
    return;
  }

  const settled = await Promise.all(
    ids.map(async (id) => {
      try {
        await loadDictionary(id, localeFor(id, locale));
        return true;
      } catch {
        // Deliberately ignored — see above.
        return false;
      }
    }),
  );

  if (mark === undefined) {
    // Advanced *after* the loads settle, and only across the leading run that
    // resolved. Moving it up front — as this first did — is a correctness bug
    // twice over: a second request arriving mid-flight reads the raised mark,
    // finds an empty slice, returns immediately and then suspends on the
    // in-flight promises anyway, which is the stream fragmentation the preload
    // exists to prevent; and a swallowed failure would be marked warm and never
    // retried. Stopping at the first failure keeps "below the watermark" and
    // "resolved" the same statement.
    const firstFailure = settled.indexOf(false);
    const reached = firstFailure === -1 ? ids.length : firstFailure;
    warmed.set(locale, Math.max(warmed.get(locale) ?? 0, from + reached));
  }
}

/**
 * Which locale a given dictionary should be warmed under.
 *
 * `useDictionary` falls back to the dictionary's own source language when the
 * app has no locale configured, so the preload has to make the same choice or
 * it caches under a key no render ever reads — warming `""`, then suspending on
 * `"en-US"` a moment later.
 */
function localeFor(id: string, locale: string): string {
  if (locale) {
    return locale;
  }
  return registry.get(id)?.locales[0] ?? locale;
}

/**
 * Seed already-known strings, skipping the loader entirely. The client calls
 * this with the SSR payload before hydration so the first render matches the
 * server without a single dictionary request.
 */
export function seedDictionaries(
  dictionaries: Record<string, LocaleStrings> | undefined,
  locale: string,
) {
  if (!dictionaries) {
    return;
  }
  for (const [id, strings] of Object.entries(dictionaries)) {
    putResolved(id, locale, strings);
  }
}

export function setActiveLocale(locale: string | undefined | null) {
  if (locale) {
    state.activeLocale = locale;
  }
}

export function getActiveLocale(): string | null {
  return state.activeLocale;
}

/**
 * Adopt strings the server streamed into the document.
 *
 * Mirrors `__GEMI_STREAM__` in `QueryManagerContext`: scripts that already ran
 * sit buffered in a plain array, and from here on `push` seeds directly. Both
 * halves are needed because dictionary scripts interleave with React's chunks —
 * a segment that reveals late carries its dictionary late too.
 *
 * Installed at module scope rather than during a render: seeding is idempotent
 * and touches no React state, and doing it here means it is already in place
 * before hydration reads anything.
 */
type StreamedDictionary = [id: string, locale: string, strings: LocaleStrings];

if (typeof window !== "undefined") {
  const w = window as unknown as {
    __GEMI_DICT__?: StreamedDictionary[] | { push: (p: StreamedDictionary) => void };
  };
  const adopt = ([id, locale, strings]: StreamedDictionary) => {
    putResolved(id, locale, strings);
  };
  const buffered = Array.isArray(w.__GEMI_DICT__) ? w.__GEMI_DICT__ : [];
  w.__GEMI_DICT__ = { push: adopt };
  for (const entry of buffered) {
    adopt(entry);
  }
}

/** Test-only: drop all state so cases do not leak into one another. */
export function __resetDictionaryRegistry() {
  registry.clear();
  resolved.clear();
  inFlight.clear();
  renderThenables.clear();
  warmed.clear();
  order.length = 0;
  state.activeLocale = null;
}
