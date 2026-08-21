export { TranslationServiceProvider } from "./TranslationServiceProvider";
export { Translator } from "./Translator";
export {
  defineTranslationConfig,
  translationConfigDefaults,
  type TranslationConfig,
} from "./config";
export { Dictionary } from "./Dictionary";

// The per-component dictionary API. `defineDictionary` is also exported from
// `gemi/client` (where components reach for it) and `gemi/dictionary` (the
// dependency-free entrypoint the Vite plugin's rewritten call sites import).
export {
  defineDictionary,
  type DictionaryHandle,
} from "./defineDictionary";
export { translate } from "./translate";
export type { DictionaryTranslations, LocaleStrings } from "./dictionaryShape";
