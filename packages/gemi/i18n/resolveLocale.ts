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

// RFC 9110 §12.4.2: a weight is 0–1 with at most three decimals.
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

type LanguageRange = { tag: string; q: number };

/**
 * Parses an `Accept-Language` header into its ranges, most preferred first:
 * by weight, then by position. An entry with a malformed weight or tag is
 * skipped; `q=0` entries are kept (they mark a language as unacceptable).
 */
function parseAcceptLanguage(header: string): LanguageRange[] {
  const ranges: (LanguageRange & { index: number })[] = [];
  for (const entry of header.split(",")) {
    const [rawTag, ...params] = entry.split(";");
    const tag = rawTag.trim();
    if (!tag || (tag !== "*" && !looksLikeLocale(tag))) {
      continue;
    }
    let q = 1;
    let valid = true;
    for (const param of params) {
      const [name, value = ""] = param.split("=");
      if (name.trim().toLowerCase() !== "q") {
        continue;
      }
      const weight = value.trim();
      if (!Q_VALUE.test(weight)) {
        valid = false;
        break;
      }
      q = Number(weight);
    }
    if (valid) {
      ranges.push({ tag, q, index: ranges.length });
    }
  }
  return ranges.sort((a, b) => b.q - a.q || a.index - b.index);
}

/** Does the language range `range` (`de`, `de-AT`) cover `locale`? (RFC 4647 basic filtering) */
function rangeCovers(range: string, locale: string): boolean {
  const r = range.replaceAll("_", "-").toLowerCase();
  const l = locale.replaceAll("_", "-").toLowerCase();
  return l === r || l.startsWith(`${r}-`);
}

/**
 * Picks the best of `supportedLocales` for a whole `Accept-Language` header,
 * or `null` when none fits.
 *
 * Entries are tried by `q` weight, highest first (ties keep header order), and
 * each is matched with {@link resolveLocale}, so `de-AT` falls back to `de`.
 * An entry with `q=0` rules out every supported locale it covers (`de;q=0`
 * rules out `de` and `de-DE`). A `*` entry, when nothing more specific fits,
 * resolves to `defaultLocale` (or the first supported locale) unless that is
 * ruled out. Malformed entries are skipped.
 *
 * ```ts
 * negotiateLocale("de-AT,de;q=0.9,en;q=0.5", ["en", "de"], "en"); // "de"
 * negotiateLocale("fr", ["en", "de"], "en"); // null
 * negotiateLocale("fr,*;q=0.1", ["en", "de"], "en"); // "en"
 * ```
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  supportedLocales: string[],
  defaultLocale?: string,
): string | null {
  if (!acceptLanguage || supportedLocales.length === 0) {
    return null;
  }

  const ranges = parseAcceptLanguage(acceptLanguage);
  const excluded = ranges.filter((r) => r.q === 0 && r.tag !== "*").map((r) => r.tag);
  const candidates = supportedLocales.filter(
    (locale) => !excluded.some((range) => rangeCovers(range, locale)),
  );
  if (candidates.length === 0) {
    return null;
  }

  let wildcard = false;
  for (const { tag, q } of ranges) {
    if (q === 0) {
      continue;
    }
    if (tag === "*") {
      wildcard = true;
      continue;
    }
    const locale = resolveLocale(tag, candidates, defaultLocale);
    if (locale) {
      return locale;
    }
  }

  if (!wildcard) {
    return null;
  }
  return (defaultLocale && candidates.includes(defaultLocale) ? defaultLocale : candidates[0]) ?? null;
}
