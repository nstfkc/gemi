import { describe, expect, test } from "vitest";
import { cssString, fontFaceRules, fontFormatOf, fontPreloads, normalizeFonts } from "./fonts";

describe("normalizeFonts", () => {
  test("resolves formats from the extension and defaults display to swap", () => {
    const [font] = normalizeFonts([
      { family: " Acme Sans ", src: "/storage/acme.woff2?v=2", weight: 400, preload: true },
    ]);
    expect(font).toEqual({
      family: "Acme Sans",
      src: [{ url: "/storage/acme.woff2?v=2", format: "woff2" }],
      weight: "400",
      style: null,
      stretch: null,
      display: "swap",
      unicodeRange: null,
      preload: true,
    });
  });

  test("keeps an explicit format and leaves an unknown extension without one", () => {
    const [font] = normalizeFonts([
      {
        family: "Acme",
        src: [{ url: "https://cdn.test/files/abc123", format: "woff2" }, { url: "/acme.ttf" }, { url: "/acme" }],
      },
    ]);
    expect(font!.src.map((s) => s.format)).toEqual(["woff2", "truetype", null]);
  });

  test.each([
    [{ family: "", src: "/a.woff2" }, /needs a family/],
    [{ family: "A", src: [] }, /needs a src/],
    [{ family: "A", src: [{ url: " " }] }, /without a url/],
    [{ family: "A", src: [{ url: "/a", format: "css" }] }, /unknown format/],
    [{ family: "A", src: "/a.woff2", weight: "400; } body { color: red" }, /weight/],
    [{ family: "A", src: "/a.woff2", style: "italic}" }, /style/],
    [{ family: "A", src: "/a.woff2", stretch: "a\nb" }, /stretch/],
    [{ family: "A", src: "/a.woff2", display: "fast" }, /display/],
    [{ family: "A", src: "/a.woff2", unicodeRange: "U+0000-00FF; }" }, /unicodeRange/],
  ])("rejects %j", (font, message) => {
    expect(() => normalizeFonts([font as any])).toThrow(message);
  });

  test("accepts variable-font ranges, oblique angles and unicode ranges", () => {
    const [font] = normalizeFonts([
      {
        family: "V",
        src: "/v.woff2",
        weight: "100 900",
        style: "oblique -10deg 10deg",
        stretch: "75% 125%",
        unicodeRange: "U+0000-00FF, U+0131, u+4??",
      },
    ]);
    expect(fontFaceRules([font!])).toEqual([
      '@font-face { font-family: "V"; src: url("/v.woff2") format("woff2"); font-weight: 100 900; font-style: oblique -10deg 10deg; font-stretch: 75% 125%; font-display: swap; unicode-range: U+0000-00FF, U+0131, u+4??; }',
    ]);
  });
});

describe("cssString", () => {
  test("escapes what could end the string, the rule or the <style> element", () => {
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(cssString("</style><script>")).toBe('"\\3c /style\\3e \\3c script\\3e "');
    expect(cssString("a\nb")).toBe('"a\\a b"');
  });
});

describe("fontFaceRules", () => {
  test("escapes family names and urls", () => {
    const rules = fontFaceRules(
      normalizeFonts([{ family: 'Evil"; } body { x', src: '/f.woff2") } </style><script>alert(1)</script>' }]),
    );
    expect(rules[0]).not.toContain("</style>");
    expect(rules[0]).toContain('font-family: "Evil\\"; } body { x"');
    expect(rules[0]).toContain('url("/f.woff2\\") } \\3c /style\\3e ');
  });

  test("collapses identical fonts", () => {
    const font = { family: "A", src: "/a.woff2", weight: 400 };
    expect(fontFaceRules(normalizeFonts([font, { ...font }, { ...font, weight: 700 }]))).toHaveLength(2);
  });
});

describe("fontPreloads", () => {
  test("preloads the first file of fonts marked preload, each url once", () => {
    const fonts = normalizeFonts([
      { family: "A", src: [{ url: "/a.woff2" }, { url: "/a.woff" }], weight: 400, preload: true },
      { family: "A", src: "/a.woff2", weight: 700, preload: true },
      { family: "B", src: "/b.ttf", preload: true },
      { family: "C", src: "/c.otf" },
      { family: "D", src: "/storage/d", preload: true },
    ]);
    expect(fontPreloads(fonts)).toEqual([
      { href: "/a.woff2", type: "font/woff2" },
      { href: "/b.ttf", type: "font/ttf" },
      { href: "/storage/d", type: null },
    ]);
  });

  test("tolerates no fonts", () => {
    expect(fontPreloads(null)).toEqual([]);
    expect(fontFaceRules(undefined)).toEqual([]);
  });
});

test("fontFormatOf ignores the query, the hash and dots in directories", () => {
  expect(fontFormatOf("/a.b/font.OTF?x=1#y")).toBe("opentype");
  expect(fontFormatOf("/a.b/font")).toBe(null);
});
