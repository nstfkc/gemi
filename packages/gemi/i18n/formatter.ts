/**
 * Locale- and time-zone-aware formatting, shared by `useFormatter`, the
 * `format` property of a `useDictionary` result and `Lang.formatter()`.
 *
 * Dependency-free on purpose: components import it, so it must not pull in the
 * server facades.
 *
 * Why the time zone is pinned: a `Date` formatted with no `timeZone` uses the
 * runtime's zone, which is the server's during SSR and the viewer's in the
 * browser. The two disagree for anyone not sitting in the server's zone, so the
 * same instant can print a different hour, or a different day, on each side —
 * a hydration mismatch at best, a wrong date at worst. Every formatter here
 * carries one zone, resolved on the server and shipped with the page, so both
 * sides print the same text.
 */

export type DateInput = Date | number | string;

export interface FormatterInit {
  /** BCP 47 locale tag. */
  locale: string;
  /** IANA time zone, such as `UTC` or `Europe/Istanbul`. */
  timeZone: string;
}

export interface Formatter {
  readonly locale: string;
  readonly timeZone: string;
  /** A date, `{ dateStyle: "medium" }` unless options are given. */
  date(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  /** A time of day, `{ timeStyle: "short" }` unless options are given. */
  time(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  /** Date and time, `{ dateStyle: "medium", timeStyle: "short" }` unless options are given. */
  dateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string;
  number(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  relative(
    value: number,
    unit: Intl.RelativeTimeFormatUnit,
    options?: Intl.RelativeTimeFormatOptions,
  ): string;
  list(values: Iterable<string>, options?: Intl.ListFormatOptions): string;
  /** The CLDR plural category for `count`: `one`, `few`, `other`, … */
  plural(count: number, options?: Intl.PluralRulesOptions): Intl.LDMLPluralRule;
  /**
   * The cached `Intl.DateTimeFormat` behind `date`/`time`/`dateTime`, with the
   * formatter's zone applied. For `formatToParts` or `formatRange`.
   */
  dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat;
}

/** The zone used when the app configures none. */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Whether `timeZone` is an IANA zone (or offset) this runtime's `Intl` accepts.
 * An unknown zone makes `Intl.DateTimeFormat` throw a `RangeError`, so a zone
 * that comes from a cookie or a user record is checked before it is trusted.
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Constructing an `Intl` formatter is the expensive part — it resolves locale
// data — so each one is built once per (kind, locale, options). Options are
// keyed by their JSON; callers pass small literal objects, and a key order
// difference only costs a duplicate entry, never a wrong result.
const cache = new Map<string, unknown>();
const CACHE_LIMIT = 500;

function cached<T>(key: string, create: () => T): T {
  let value = cache.get(key) as T | undefined;
  if (value === undefined) {
    if (cache.size >= CACHE_LIMIT) {
      // Insertion order: drop the oldest. Unbounded user-driven option objects
      // (a currency per row) must not grow a long-lived server process forever.
      cache.delete(cache.keys().next().value!);
    }
    value = create();
    cache.set(key, value);
  }
  return value;
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function hasDateTimeFields(options: Intl.DateTimeFormatOptions): boolean {
  return (
    options.dateStyle !== undefined ||
    options.timeStyle !== undefined ||
    options.weekday !== undefined ||
    options.era !== undefined ||
    options.year !== undefined ||
    options.month !== undefined ||
    options.day !== undefined ||
    options.dayPeriod !== undefined ||
    options.hour !== undefined ||
    options.minute !== undefined ||
    options.second !== undefined ||
    options.fractionalSecondDigits !== undefined ||
    options.timeZoneName !== undefined
  );
}

export function createFormatter(init: FormatterInit): Formatter {
  const { locale, timeZone } = init;

  const dateTimeFormat = (options: Intl.DateTimeFormatOptions = {}) => {
    // `??`, not a spread: `{ timeZone: undefined }` would otherwise drop the
    // pinned zone and fall back to the runtime's, which is the bug this exists
    // to prevent.
    const resolved = { ...options, timeZone: options.timeZone ?? timeZone };
    return cached(`dt|${locale}|${JSON.stringify(resolved)}`, () => {
      return new Intl.DateTimeFormat(locale, resolved);
    });
  };

  const withDefaults = (
    options: Intl.DateTimeFormatOptions | undefined,
    defaults: Intl.DateTimeFormatOptions,
  ) => {
    if (options && hasDateTimeFields(options)) {
      return options;
    }
    // Options that only tweak (a `timeZone`, `hour12`) still get the default
    // fields; otherwise `{ timeZone }` alone would print a bare numeric date.
    return { ...defaults, ...options };
  };

  return {
    locale,
    timeZone,
    date(value, options) {
      return dateTimeFormat(withDefaults(options, { dateStyle: "medium" })).format(
        toDate(value),
      );
    },
    time(value, options) {
      return dateTimeFormat(withDefaults(options, { timeStyle: "short" })).format(
        toDate(value),
      );
    },
    dateTime(value, options) {
      return dateTimeFormat(
        withDefaults(options, { dateStyle: "medium", timeStyle: "short" }),
      ).format(toDate(value));
    },
    number(value, options = {}) {
      return cached(
        `n|${locale}|${JSON.stringify(options)}`,
        () => new Intl.NumberFormat(locale, options),
      ).format(value);
    },
    relative(value, unit, options = {}) {
      return cached(
        `r|${locale}|${JSON.stringify(options)}`,
        () => new Intl.RelativeTimeFormat(locale, options),
      ).format(value, unit);
    },
    list(values, options = {}) {
      return cached(
        `l|${locale}|${JSON.stringify(options)}`,
        () => new Intl.ListFormat(locale, options),
      ).format(values);
    },
    plural(count, options = {}) {
      return cached(
        `p|${locale}|${JSON.stringify(options)}`,
        () => new Intl.PluralRules(locale, options),
      ).select(count);
    },
    dateTimeFormat,
  };
}
