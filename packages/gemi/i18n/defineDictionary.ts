import {
  dictionaryId,
  dictionaryLocales,
  localeStrings,
  type DictionaryTranslations,
  type LocaleStrings,
} from "./dictionaryShape";
import {
  loadDictionary,
  loadDictionaryForRender,
  registerDictionary,
} from "./dictionaryRegistry";

declare const brand: unique symbol;

export interface DictionaryHandle<
  T extends DictionaryTranslations = DictionaryTranslations,
> {
  readonly id: string;
  /** Locales this dictionary declares, source language first. */
  readonly locales: readonly string[];
  /**
   * Strings for `locale`. Synchronous when they are already in memory —
   * always, for an unbundled dictionary; after a preload or the SSR seed, for a
   * bundled one.
   */
  load(locale: string): LocaleStrings | Promise<LocaleStrings>;
  /**
   * `load`, but never rejecting — safe to hand React's `use()`. A failed locale
   * chunk resolves to no strings so the component degrades to rendering keys
   * instead of unmounting into an error boundary.
   */
  loadForRender(locale: string): LocaleStrings | Promise<LocaleStrings>;
  get(locale: string): LocaleStrings | undefined;
  /** Type-only: carries the literal's shape through to `useDictionary`. */
  readonly [brand]?: T;
}

/**
 * Declare the strings a component needs, next to the component.
 *
 * ```ts
 * export const homeDict = defineDictionary({
 *   title: { "en-US": "Welcome {{name}}", "tr-TR": "Hoş geldin {{name}}" },
 * });
 * ```
 *
 * As written this holds every locale. Under gemi's Vite plugin the call is
 * rewritten so each locale becomes its own chunk and a page downloads only the
 * one it renders in — but the plugin is strictly an optimization, and the
 * behaviour is identical without it (in `bun test`, and in server code that
 * does not go through the bundler).
 *
 * The first locale in the literal is the source language: a key missing from
 * another locale falls back to it rather than rendering as its own key.
 */
export interface DefineDictionaryOptions {
  /**
   * The locale this dictionary is authored in. Keys missing from another locale
   * fall back to it, and it is what renders when the app has no locale
   * configured.
   *
   * Optional, but worth setting on any dictionary that is not uniformly
   * translated: without it the source language is whichever locale appears
   * first in the literal, so adding a key at the top can re-point every
   * fallback in the dictionary.
   */
  sourceLocale?: string;
}

export function defineDictionary<const T extends DictionaryTranslations>(
  translations: T,
  options: DefineDictionaryOptions = {},
): DictionaryHandle<T> {
  const locales = dictionaryLocales(translations, options.sourceLocale);
  return createHandle(dictionaryId(translations), locales, (locale) =>
    localeStrings(translations, locale, locales),
  );
}

/**
 * The rewritten form of a `defineDictionary` call — emitted by
 * `packages/gemi/vite/dictionaryPlugin.ts`, never written by hand. `loaders`
 * holds one dynamic import per locale so the bundler emits one chunk per
 * locale and the untaken ones never reach the browser.
 */
export function __gemi_dict__<
  const T extends DictionaryTranslations = DictionaryTranslations,
>(
  id: string,
  loaders: Record<string, () => Promise<{ default: LocaleStrings }>>,
): DictionaryHandle<T> {
  const locales = Object.keys(loaders);
  return createHandle(id, locales, (locale) => {
    // An unknown locale falls back to the source language, matching what
    // `localeStrings` does per key on the unbundled path.
    const load = loaders[locale] ?? loaders[locales[0]];
    if (!load) {
      return {};
    }
    return load().then((mod) => mod.default);
  });
}

function createHandle<T extends DictionaryTranslations>(
  id: string,
  locales: string[],
  load: (locale: string) => LocaleStrings | Promise<LocaleStrings>,
): DictionaryHandle<T> {
  const entry = { id, locales, load };
  registerDictionary(entry);

  // Re-asserted on every read rather than only at construction. A handle is
  // created once, at module scope, but the registry it delegates to can be
  // emptied under it — a test's `afterEach` reset, an HMR boundary — and the
  // handle would then be permanently orphaned, throwing "Unknown dictionary"
  // for a dictionary the caller is holding. `registerDictionary` is a no-op
  // when the id is already there, so this costs one Map lookup.
  const ensure = () => registerDictionary(entry);

  return {
    id,
    locales,
    // Routed through the registry rather than calling `load` directly so
    // concurrent readers share one in-flight import and results are cached.
    load: (locale: string) => {
      ensure();
      return loadDictionary(id, locale);
    },
    loadForRender: (locale: string) => {
      ensure();
      return loadDictionaryForRender(id, locale);
    },
    get: (locale: string) => {
      ensure();
      const strings = loadDictionary(id, locale);
      if (strings instanceof Promise) {
        // Nothing downstream awaits this one — `get` is the synchronous peek,
        // and the caller is about to discard it. An unattached rejection (a
        // locale chunk that 404s mid-deploy) would surface as an
        // `unhandledRejection`, which under Node's default handler takes the
        // process down over one missing translation file. The load itself is
        // still cached and still retried through `loadDictionary`.
        strings.catch(() => {});
        return undefined;
      }
      return strings;
    },
  };
}

