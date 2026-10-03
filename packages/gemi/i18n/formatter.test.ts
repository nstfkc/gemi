import { describe, expect, test } from "vitest";

import { createFormatter, DEFAULT_TIME_ZONE, isValidTimeZone } from "./formatter";

/**
 * 2026-11-01T22:30:00Z: still the 1st in UTC, already the 2nd in Istanbul
 * (UTC+3) and in Tokyo. An instant that crosses midnight is the one that shows
 * a zone bug as a wrong *day*, not just a wrong hour.
 */
const lateEvening = Date.UTC(2026, 10, 1, 22, 30);

describe("createFormatter", () => {
  test("formats in its own zone, not the runtime's", () => {
    const utc = createFormatter({ locale: "en-US", timeZone: "UTC" });
    const istanbul = createFormatter({ locale: "en-US", timeZone: "Europe/Istanbul" });

    expect(utc.date(lateEvening)).toBe("Nov 1, 2026");
    expect(istanbul.date(lateEvening)).toBe("Nov 2, 2026");
    expect(utc.time(lateEvening, { hour: "2-digit", minute: "2-digit", hour12: false })).toBe(
      "22:30",
    );
    expect(
      istanbul.time(lateEvening, { hour: "2-digit", minute: "2-digit", hour12: false }),
    ).toBe("01:30");
  });

  test("a per-call timeZone overrides the formatter's", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
    expect(f.date(lateEvening, { timeZone: "Asia/Tokyo" })).toBe("Nov 2, 2026");
    // Options that carry only a zone still get the default date fields.
    expect(f.date(lateEvening, { timeZone: "Asia/Tokyo" })).toBe(
      f.date(lateEvening, { dateStyle: "medium", timeZone: "Asia/Tokyo" }),
    );
  });

  test("an explicit `timeZone: undefined` keeps the pinned zone", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "Europe/Istanbul" });
    expect(f.date(lateEvening, { timeZone: undefined })).toBe("Nov 2, 2026");
    expect(f.dateTimeFormat({ timeZone: undefined }).resolvedOptions().timeZone).toBe(
      "Europe/Istanbul",
    );
  });

  test("accepts a Date, a timestamp and an ISO string", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
    const iso = new Date(lateEvening).toISOString();
    expect(f.date(new Date(lateEvening))).toBe("Nov 1, 2026");
    expect(f.date(iso)).toBe("Nov 1, 2026");
    // A date-only string is UTC midnight, so the default zone prints that day.
    expect(f.date("2026-11-01")).toBe("Nov 1, 2026");
  });

  test("follows the locale", () => {
    const f = createFormatter({ locale: "tr-TR", timeZone: "UTC" });
    expect(f.date(lateEvening, { day: "numeric", month: "long", year: "numeric" })).toBe(
      "1 Kasım 2026",
    );
    expect(f.number(1199.88, { minimumFractionDigits: 2 })).toBe("1.199,88");
  });

  test("dateTime prints both parts in the zone", () => {
    const f = createFormatter({ locale: "en-GB", timeZone: "Europe/Istanbul" });
    expect(f.dateTime(lateEvening, { dateStyle: "short", timeStyle: "short" })).toBe(
      "02/11/2026, 01:30",
    );
  });

  test("numbers, relative times, lists and plural categories", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
    expect(f.number(1199.88, { style: "currency", currency: "USD" })).toBe("$1,199.88");
    expect(f.relative(-3, "day")).toBe("3 days ago");
    expect(f.relative(-1, "day", { numeric: "auto" })).toBe("yesterday");
    expect(f.list(["a", "b", "c"])).toBe("a, b, and c");
    expect(f.plural(1)).toBe("one");
    expect(f.plural(2)).toBe("other");
    expect(f.plural(2, { type: "ordinal" })).toBe("two");
  });

  test("reuses the Intl formatter for the same locale, zone and options", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
    const g = createFormatter({ locale: "en-US", timeZone: "UTC" });
    expect(f.dateTimeFormat({ dateStyle: "long" })).toBe(g.dateTimeFormat({ dateStyle: "long" }));
    expect(f.dateTimeFormat({ dateStyle: "long" })).not.toBe(
      f.dateTimeFormat({ dateStyle: "long", timeZone: "Asia/Tokyo" }),
    );
  });

  test("an unknown per-call zone throws, like Intl", () => {
    const f = createFormatter({ locale: "en-US", timeZone: "UTC" });
    expect(() => f.date(lateEvening, { timeZone: "Mars/Olympus" })).toThrow(RangeError);
  });
});

describe("isValidTimeZone", () => {
  test.each(["UTC", "Europe/Istanbul", "America/New_York"])("accepts %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  test.each(["", "Mars/Olympus", null, undefined, 3])("rejects %s", (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });

  test("the default is UTC", () => {
    expect(DEFAULT_TIME_ZONE).toBe("UTC");
  });
});
