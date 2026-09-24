// A BCP 47-ish tag: a 2–3 letter language, then any number of subtags. Loose on
// purpose — it only has to tell `en`, `de-AT` and `zh-Hant-TW` apart from path
// segments like `blog` or `settings`.
const LOCALE_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

export function looksLikeLocale(segment: string): boolean {
  return LOCALE_TAG.test(segment);
}

function languageOf(tag: string): string {
  return tag.split(/[-_]/)[0].toLowerCase();
}

/**
 * Maps a requested locale onto one the app supports, or `null` when none fits.
 *
 * An exact match wins, ignoring case (`en-us` → `en-US`). Otherwise the tag
 * falls back to a supported locale of the same language, so a short tag
 * resolves to its long form (`en` → `en-US`) and an unsupported region to a
 * supported one (`de-AT` → `de-DE`). When several share the language, the
 * default locale is preferred, then the first in `supportedLocales`.
 */
export function resolveLocale(
  requested: string | null | undefined,
  supportedLocales: string[],
  defaultLocale?: string,
): string | null {
  // An `Accept-Language` entry may carry a weight: `de-AT;q=0.9`.
  const tag = requested?.split(";")[0].trim();
  if (!tag || !looksLikeLocale(tag)) {
    return null;
  }

  const normalized = tag.replaceAll("_", "-").toLowerCase();
  const exact = supportedLocales.find((l) => l.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const language = languageOf(tag);
  const sameLanguage = supportedLocales.filter((l) => languageOf(l) === language);
  if (sameLanguage.length === 0) {
    return null;
  }
  if (defaultLocale && sameLanguage.includes(defaultLocale)) {
    return defaultLocale;
  }
  return sameLanguage[0];
}
