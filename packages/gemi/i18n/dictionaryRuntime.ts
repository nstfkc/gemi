/**
 * `gemi/dictionary` — the runtime behind `defineDictionary`, and nothing else.
 *
 * Deliberately tiny and dependency-free: no React, no facades, no service
 * container. Dictionaries are authored next to components but also read from
 * controllers, jobs and email templates, so this has to be importable from
 * either side, and the Vite plugin's rewritten call sites import `__gemi_dict__`
 * from here. It is in `GEMI_EXTERNAL_SPECIFIERS`, so an SSR-built view resolves
 * it to the server's own instance — one registry, shared with the view router
 * that preloads through it.
 */
export {
  defineDictionary,
  __gemi_dict__,
  type DictionaryHandle,
} from "./defineDictionary";

export {
  preloadDictionaries,
  seedDictionaries,
  loadDictionary,
  dictionaryRegistrationMark,
  getActiveLocale,
  setActiveLocale,
  __resetDictionaryRegistry,
  type LocaleStrings,
} from "./dictionaryRegistry";

export {
  createDictionarySink,
  type DictionarySink,
  type DictionaryUse,
} from "./dictionarySink";

export {
  dictionaryId,
  dictionaryLocales,
  localeStrings,
  type DictionaryTranslations,
} from "./dictionaryShape";
