import { describe, expect, test } from "vitest";

import { translationConfigDefaults, type TranslationConfig } from "./config";
import { Translator } from "./Translator";
import { withDefaults } from "../support/withDefaults";

const lateEvening = Date.UTC(2026, 10, 1, 22, 30);

function translator(config: Partial<TranslationConfig> = {}) {
  return new Translator(withDefaults(translationConfigDefaults(), config));
}

/** Only `detectTimeZone` reads the request, and it is the app's own function. */
const req = {} as any;

describe("Translator time zone", () => {
  test("defaults to UTC", () => {
    const t = translator();
    expect(t.timeZone).toBe("UTC");
    expect(t.detectTimeZone(req)).toBe("UTC");
    expect(t.formatter().date(lateEvening)).toBe("Nov 1, 2026");
  });

  test("uses the configured zone", () => {
    const t = translator({ timeZone: "Europe/Istanbul" });
    expect(t.detectTimeZone(req)).toBe("Europe/Istanbul");
    expect(t.formatter().date(lateEvening)).toBe("Nov 2, 2026");
  });

  test("refuses to boot with a zone Intl does not know", () => {
    expect(() => translator({ timeZone: "Europe/Atlantis" })).toThrow(
      /translation\.timeZone.*Europe\/Atlantis/,
    );
  });

  test("detectTimeZone wins when it returns a valid zone", () => {
    const t = translator({ detectTimeZone: () => "Asia/Tokyo" });
    expect(t.detectTimeZone(req)).toBe("Asia/Tokyo");
  });

  test.each([null, "", "not/a-zone"])(
    "a detectTimeZone answer of %j falls back to the configured zone",
    (answer) => {
      const t = translator({
        timeZone: "Europe/Istanbul",
        detectTimeZone: () => answer as string | null,
      });
      expect(t.detectTimeZone(req)).toBe("Europe/Istanbul");
    },
  );

  test("outside a request there is nothing to detect from", () => {
    const t = translator({ timeZone: "Europe/Istanbul", detectTimeZone: () => "Asia/Tokyo" });
    expect(t.detectTimeZone(null)).toBe("Europe/Istanbul");
  });

  test("formatter takes a locale and a zone, falling back to the defaults", () => {
    const t = translator({ defaultLocale: "tr-TR" });
    expect(t.formatter().locale).toBe("tr-TR");
    expect(t.formatter("en-GB").locale).toBe("en-GB");
    expect(t.formatter("en-US", "Asia/Tokyo").date(lateEvening)).toBe("Nov 2, 2026");
    expect(t.formatter("en-US", "bogus").timeZone).toBe("UTC");
  });
});
