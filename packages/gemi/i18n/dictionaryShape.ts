/**
 * The one implementation of "what is a dictionary literal, and what is its id",
 * shared by the runtime (`defineDictionary`) and the Vite plugin.
 *
 * Both sides must agree exactly. A dictionary's id is a hash of its own
 * contents rather than of its file path, so a module that is bundled on one
 * side and evaluated raw on the other still lands on the same id — which is
 * what lets the SSR payload seed the client registry.
 */

export type DictionaryTranslations = Record<string, Record<string, string>>;

export type LocaleStrings = Record<string, string>;

/**
 * Locales the dictionary declares, source language first.
 *
 * The order is meaningful: the first locale is the source language, and a key
 * missing from some other locale falls back along this list.
 *
 * `sourceLocale` pins that choice. Without it the source language is whichever
 * locale is seen first while walking the literal, which makes it an emergent
 * property of key order — adding a key at the top of a dictionary whose other
 * keys happen to lack `en-US` would silently re-point every fallback in it. Any
 * dictionary that is not uniformly translated should say which locale it is
 * authored in.
 */
export function dictionaryLocales(
  translations: DictionaryTranslations,
  sourceLocale?: string,
): string[] {
  const locales: string[] = [];
  const seen = new Set<string>();
  if (sourceLocale) {
    seen.add(sourceLocale);
    locales.push(sourceLocale);
  }
  for (const byLocale of Object.values(translations)) {
    for (const locale of Object.keys(byLocale)) {
      if (!seen.has(locale)) {
        seen.add(locale);
        locales.push(locale);
      }
    }
  }
  return locales;
}

/**
 * Flatten one locale out of a dictionary.
 *
 * A key with no string for `locale` falls back along the declared locale order
 * rather than vanishing, so a half-translated dictionary degrades one string at
 * a time instead of rendering the whole component as raw keys.
 */
export function localeStrings(
  translations: DictionaryTranslations,
  locale: string,
  fallbackOrder: string[] = dictionaryLocales(translations),
): LocaleStrings {
  const out: LocaleStrings = {};
  for (const [key, byLocale] of Object.entries(translations)) {
    let value = byLocale?.[locale];
    if (typeof value !== "string") {
      for (const candidate of fallbackOrder) {
        const fallback = byLocale?.[candidate];
        if (typeof fallback === "string") {
          value = fallback;
          break;
        }
      }
    }
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export interface SourceDisagreement {
  key: string;
  first: string;
  againstKey: string;
  againstFirst: string;
}

/**
 * Whether the inferred source language survives reordering the literal.
 *
 * `dictionaryLocales` collects locales entry by entry, so `locales[0]` is the
 * first locale of the first entry. That is invariant under key reordering
 * exactly when every entry lists the same locale first — and order-dependent
 * the moment two entries disagree, because then whichever happens to be written
 * first decides what the *whole* dictionary falls back to. Adding one key at
 * the top can flip every other key's fallback language, from a diff that reads
 * as an addition.
 *
 * Returns the disagreement so the build can name both keys; `null` when the
 * inference is stable. `sourceLocale` settles it and makes the question moot.
 */
export function findSourceDisagreement(
  translations: DictionaryTranslations,
): SourceDisagreement | null {
  let againstKey: string | undefined;
  let againstFirst: string | undefined;

  for (const [key, byLocale] of Object.entries(translations)) {
    const first = Object.keys(byLocale ?? {})[0];
    // A key with no locales at all is a different problem, reported elsewhere.
    if (first === undefined) continue;

    if (againstFirst === undefined) {
      againstFirst = first;
      againstKey = key;
      continue;
    }
    if (first !== againstFirst) {
      return { key, first, againstKey: againstKey!, againstFirst };
    }
  }
  return null;
}

/**
 * Canonical serialization — key order in the source file must not change the
 * id, or an innocuous reordering would break the payload/registry match.
 */
export function canonicalizeDictionary(
  translations: DictionaryTranslations,
): string {
  const keys = Object.keys(translations).sort();
  const parts = keys.map((key) => {
    const byLocale = translations[key] ?? {};
    const locales = Object.keys(byLocale).sort();
    const inner = locales.map((l) => JSON.stringify([l, byLocale[l]])).join(",");
    return `${JSON.stringify(key)}:[${inner}]`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * FNV-1a, run twice with different offsets for a 64-bit-wide id. No crypto
 * import, and it has to work identically in the browser bundle, under Bun on
 * the server, and inside the Vite plugin.
 */
export function dictionaryId(translations: DictionaryTranslations): string {
  const input = canonicalizeDictionary(translations);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `d_${hex(a)}${hex(b)}`;
}
