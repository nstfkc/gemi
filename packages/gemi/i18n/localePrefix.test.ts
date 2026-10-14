import { describe, expect, test } from "vitest";

import { splitLocalePrefix } from "./localePrefix";

const locales = ["en-US", "de-DE", "de"];

describe("splitLocalePrefix", () => {
  test.each([
    ["/de-DE", "de-DE", "/"],
    ["/de-DE/", "de-DE", "/"],
    ["/de-DE/about", "de-DE", "/about"],
    ["/de-DE/about/", "de-DE", "/about/"],
    ["/de-DE/de-DE", "de-DE", "/de-DE"],
    ["/de/settings", "de", "/settings"],
  ])("%s carries %s and leaves %s", (path, locale, rest) => {
    expect(splitLocalePrefix(path, locales)).toEqual({ locale, pathname: rest });
  });

  test.each([
    "/",
    "/about",
    // Routes whose first segment only starts like a locale.
    "/de-DE-shop",
    "/delivery",
    "/de-DEx/about",
    // A locale that is not the first segment.
    "/about/de-DE",
  ])("%s carries no locale", (path) => {
    expect(splitLocalePrefix(path, locales)).toEqual({ locale: null, pathname: path });
  });

  test("an empty pathname is the root", () => {
    expect(splitLocalePrefix("", locales)).toEqual({ locale: null, pathname: "/" });
  });
});
