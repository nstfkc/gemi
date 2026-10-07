import { describe, expect, test } from "vitest";
import { HttpRequest } from "../http/HttpRequest";
import { Translator } from "./Translator";
import { translationConfigDefaults } from "./config";
import { negotiateLocale } from "./resolveLocale";
import * as i18n from "./index";

describe("negotiateLocale", () => {
  test("the issue's example", () => {
    expect(negotiateLocale("de-AT,de;q=0.9,en;q=0.5", ["en", "de"], "en")).toBe("de");
  });

  test("orders by q weight, not header position", () => {
    expect(negotiateLocale("en;q=0.5,de", ["en", "de"])).toBe("de");
    expect(negotiateLocale("en;q=0.2,tr;q=0.8,de;q=0.5", ["en", "de", "tr"])).toBe("tr");
  });

  test("equal weights keep header order", () => {
    expect(negotiateLocale("de;q=0.8,en;q=0.8", ["en", "de"])).toBe("de");
    expect(negotiateLocale("tr,de", ["en", "de", "tr"])).toBe("tr");
  });

  test("a missing weight is 1", () => {
    expect(negotiateLocale("en;q=0.999,de", ["en", "de"])).toBe("de");
    expect(negotiateLocale("en;q=1.000,de;q=1", ["en", "de"])).toBe("en");
  });

  test("a regional tag falls back to its language", () => {
    expect(negotiateLocale("en-GB", ["en", "de"])).toBe("en");
    expect(negotiateLocale("en-GB", ["en-US", "de-DE"])).toBe("en-US");
    expect(negotiateLocale("de-AT", ["en-US", "de-DE", "de-AT"])).toBe("de-AT");
  });

  test("the default locale wins among same-language candidates", () => {
    expect(negotiateLocale("en", ["en-GB", "en-US"], "en-US")).toBe("en-US");
  });

  test("walks past entries nothing fits", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,tr;q=0.8", ["en-US", "tr-TR"])).toBe("tr-TR");
  });

  test("returns null when nothing fits", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9", ["en", "de"], "en")).toBeNull();
    expect(negotiateLocale("", ["en"], "en")).toBeNull();
    expect(negotiateLocale(null, ["en"], "en")).toBeNull();
    expect(negotiateLocale(undefined, ["en"], "en")).toBeNull();
    expect(negotiateLocale("en", [], "en")).toBeNull();
  });

  describe("q=0", () => {
    test("an entry with q=0 is never chosen", () => {
      expect(negotiateLocale("de;q=0,en;q=0.1", ["en", "de"])).toBe("en");
      expect(negotiateLocale("de;q=0", ["en", "de"])).toBeNull();
      expect(negotiateLocale("de;q=0.000", ["en", "de"])).toBeNull();
    });

    test("rules out every locale the range covers, even via a regional fallback", () => {
      // `de-AT` would fall back to `de-DE`, but the visitor refused German.
      expect(negotiateLocale("de-AT,de;q=0", ["en-US", "de-DE"], "en-US")).toBeNull();
    });

    test("a narrower q=0 range leaves the rest of the language", () => {
      expect(negotiateLocale("en,en-GB;q=0", ["en-GB", "en-US"])).toBe("en-US");
    });
  });

  describe("wildcard", () => {
    test("* falls back to the default locale when nothing more specific fits", () => {
      expect(negotiateLocale("fr,*;q=0.1", ["en", "de"], "de")).toBe("de");
      expect(negotiateLocale("*", ["en", "de"], "de")).toBe("de");
    });

    test("* falls back to the first supported locale without a default", () => {
      expect(negotiateLocale("*", ["en", "de"])).toBe("en");
    });

    test("a specific match beats *, whatever the weights", () => {
      expect(negotiateLocale("*,de;q=0.5", ["en", "de"], "en")).toBe("de");
    });

    test("* skips locales ruled out by q=0", () => {
      expect(negotiateLocale("en;q=0,*", ["en", "de"], "en")).toBe("de");
      expect(negotiateLocale("en;q=0,de;q=0,*", ["en", "de"], "en")).toBeNull();
    });

    test("*;q=0 is not a fallback", () => {
      expect(negotiateLocale("fr,*;q=0", ["en", "de"], "en")).toBeNull();
    });
  });

  describe("malformed headers", () => {
    test("skips entries with a malformed weight", () => {
      expect(negotiateLocale("de;q=abc,en", ["en", "de"])).toBe("en");
      expect(negotiateLocale("de;q=2,en", ["en", "de"])).toBe("en");
      expect(negotiateLocale("de;q=-1,en", ["en", "de"])).toBe("en");
      expect(negotiateLocale("de;q=0.12345,en", ["en", "de"])).toBe("en");
      expect(negotiateLocale("de;q=,en", ["en", "de"])).toBe("en");
    });

    test("skips tags that are not locales", () => {
      expect(negotiateLocale("<script>,de", ["en", "de"])).toBe("de");
      expect(negotiateLocale("en-toolongsubtag,de", ["en", "de"])).toBe("de");
      expect(negotiateLocale(";q=1,de", ["en", "de"])).toBe("de");
    });

    test("tolerates whitespace, empty entries, case and other parameters", () => {
      expect(negotiateLocale(" , en ; q=0.4 ,, DE-at ; Q=0.6 ", ["en", "de"])).toBe("de");
      expect(negotiateLocale("de;level=1;q=0.9,en;q=0.5", ["en", "de"])).toBe("de");
    });

    test("garbage resolves to nothing", () => {
      expect(negotiateLocale(",,;;==", ["en", "de"], "en")).toBeNull();
      expect(negotiateLocale("a".repeat(10_000), ["en"], "en")).toBeNull();
    });
  });

  test("is exported from gemi/i18n", () => {
    expect(i18n.negotiateLocale).toBe(negotiateLocale);
  });
});

describe("Translator.detectLocale with q weights", () => {
  const translator = new Translator({
    ...translationConfigDefaults(),
    supportedLocales: ["en-US", "de-DE", "tr-TR"],
    defaultLocale: "en-US",
  });

  const request = (headers: Record<string, string>) =>
    new HttpRequest(new Request("http://localhost/", { headers }), {}, "view", "/");

  test("follows weights rather than header order", () => {
    expect(translator.detectLocale(request({ "accept-language": "en;q=0.3,tr;q=0.9" }))).toBe("tr-TR");
  });

  test("falls back to the default locale when every match is refused", () => {
    expect(translator.detectLocale(request({ "accept-language": "de;q=0" }))).toBe("en-US");
  });
});
