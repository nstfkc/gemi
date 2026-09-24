import { describe, expect, test } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { Translator } from "./Translator";
import { translationConfigDefaults } from "./config";
import { looksLikeLocale, resolveLocale } from "./resolveLocale";

const supported = ["en-US", "de-DE", "tr-TR"];

describe("resolveLocale", () => {
  test("a short tag resolves to its long form", () => {
    expect(resolveLocale("en", supported)).toBe("en-US");
    expect(resolveLocale("de", supported)).toBe("de-DE");
  });

  test("an unsupported region falls back to a supported one of the same language", () => {
    expect(resolveLocale("de-AT", supported)).toBe("de-DE");
    expect(resolveLocale("en-GB", supported)).toBe("en-US");
  });

  test("a supported region is kept", () => {
    expect(resolveLocale("de-AT", ["de-DE", "de-AT"])).toBe("de-AT");
  });

  test("matches ignore case and accept underscores", () => {
    expect(resolveLocale("en-us", supported)).toBe("en-US");
    expect(resolveLocale("de_DE", supported)).toBe("de-DE");
  });

  test("prefers the default locale among same-language candidates", () => {
    expect(resolveLocale("en", ["en-GB", "en-US"], "en-US")).toBe("en-US");
    expect(resolveLocale("en", ["en-GB", "en-US"])).toBe("en-GB");
  });

  test("an unknown language or a non-locale segment resolves to nothing", () => {
    expect(resolveLocale("fr", supported)).toBeNull();
    expect(resolveLocale("about", supported)).toBeNull();
    expect(resolveLocale("", supported)).toBeNull();
    expect(resolveLocale(undefined, supported)).toBeNull();
  });

  test("an Accept-Language weight is ignored", () => {
    expect(resolveLocale("de-AT;q=0.9", supported)).toBe("de-DE");
  });
});

describe("Translator.detectLocale", () => {
  const translator = new Translator({
    ...translationConfigDefaults(),
    supportedLocales: supported,
    defaultLocale: "en-US",
  });

  const request = (headers: Record<string, string>) =>
    new HttpRequest(new Request("http://localhost/", { headers }), {}, "view", "/");

  test("resolves a regional Accept-Language to the supported locale", () => {
    expect(translator.detectLocale(request({ "accept-language": "de-AT,de;q=0.9" }))).toBe("de-DE");
  });

  test("walks Accept-Language past entries the app can't serve", () => {
    expect(translator.detectLocale(request({ "accept-language": "fr-FR,tr;q=0.8" }))).toBe("tr-TR");
  });

  test("resolves a short cookie locale", () => {
    expect(translator.detectLocale(request({ cookie: "i18n-locale=de" }))).toBe("de-DE");
  });

  test("falls back to the default locale", () => {
    expect(translator.detectLocale(request({ "accept-language": "fr-FR" }))).toBe("en-US");
  });
});

describe("looksLikeLocale", () => {
  /**
   * This is the only thing separating a locale prefix from an ordinary path
   * segment, so it is what decides whether a URL is redirected at all.
   */
  test.each(["en", "de", "en-US", "de_AT", "zh-Hant-TW", "eng"])("%s is a tag", (segment) => {
    expect(looksLikeLocale(segment)).toBe(true);
  });

  test.each(["blog", "settings", "a", "about-us", "2024", "-en", "en-", "en-toolongsubtag"])(
    "%s is not",
    (segment) => {
      expect(looksLikeLocale(segment)).toBe(false);
    },
  );

  /**
   * The gate only shows on a segment whose *language* the app supports but
   * whose shape is not a tag — without it, the same-language fallback happily
   * maps `/en-toolongsubtag` onto `en-US` and redirects a path away.
   */
  test.each(["en-toolongsubtag", "en-", "en_", "en-US-", "en--US"])(
    "refuses %s even though its language is supported",
    (segment) => {
      expect(resolveLocale(segment, ["en-US", "de-DE"], "en-US")).toBeNull();
    },
  );
});

describe("resolveLocale separators", () => {
  /** `de_AT` and `de-AT` are the same tag, and the exact match must see that. */
  test("an underscore tag matches its hyphenated locale exactly", () => {
    expect(resolveLocale("de_AT", ["de-DE", "de-AT"], "de-DE")).toBe("de-AT");
    expect(resolveLocale("zh_Hant_TW", ["zh-Hans-CN", "zh-Hant-TW"])).toBe("zh-Hant-TW");
  });
});
