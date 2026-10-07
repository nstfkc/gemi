/**
 * `Meta.fonts`: the `@font-face` rules and font preloads of one response.
 * Pure, so the server (validation) and `<Head />` (rendering) share it.
 */

/** A font file format, as `@font-face`'s `format()` names it. */
export type FontFormat =
  | "woff2"
  | "woff"
  | "truetype"
  | "opentype"
  | "collection"
  | "embedded-opentype"
  | "svg";

/** One file of a font; list the preferred format first. */
export type FontSource = {
  url: string;
  /** Inferred from the url's extension when left out. */
  format?: FontFormat;
};

/** One `@font-face`, see `Meta.fonts`. */
export type MetaFont = {
  /** The `font-family` name that CSS refers to, e.g. `"Acme Sans"`. */
  family: string;
  /** A url, or several files with the preferred one first. */
  src: string | FontSource[];
  /** `font-weight`: `400`, `"bold"`, or a range for a variable font, `"100 900"`. */
  weight?: string | number;
  /** `font-style`: `"normal"`, `"italic"`, `"oblique 10deg"`. */
  style?: string;
  /** `font-stretch`: `"condensed"`, `"75% 125%"`. */
  stretch?: string;
  /** `font-display`. Defaults to `"swap"`. */
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
  /** `unicode-range`, e.g. `"U+0000-00FF, U+0131"`. */
  unicodeRange?: string;
  /**
   * Preload the first file with `<link rel="preload" as="font" crossorigin>`.
   * Only for fonts the page renders above the fold: a preloaded font that is
   * never used is a wasted download (and a console warning).
   */
  preload?: boolean;
};

/** A font after `normalizeFonts`: validated, with every source's format resolved. */
export type NormalizedFont = {
  family: string;
  src: { url: string; format: FontFormat | null }[];
  weight: string | null;
  style: string | null;
  stretch: string | null;
  display: NonNullable<MetaFont["display"]>;
  unicodeRange: string | null;
  preload: boolean;
};

export type FontPreload = { href: string; type: string | null };

const FORMATS = new Set<FontFormat>([
  "woff2",
  "woff",
  "truetype",
  "opentype",
  "collection",
  "embedded-opentype",
  "svg",
]);

const FORMAT_BY_EXTENSION: Record<string, FontFormat> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
  ttc: "collection",
  eot: "embedded-opentype",
  svg: "svg",
};

const MIME_BY_FORMAT: Partial<Record<FontFormat, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  truetype: "font/ttf",
  opentype: "font/otf",
  collection: "font/collection",
};

const DISPLAYS = new Set(["auto", "block", "swap", "fallback", "optional"]);

// Descriptors are written into the CSS as they are, so only keywords, numbers,
// angles and percentages pass: nothing that can end the declaration or rule.
const DESCRIPTOR = /^[a-zA-Z0-9.%+\- ]+$/;
const UNICODE_RANGE = /^[uU]\+[0-9a-fA-F?]{1,6}(-[0-9a-fA-F]{1,6})?(\s*,\s*[uU]\+[0-9a-fA-F?]{1,6}(-[0-9a-fA-F]{1,6})?)*$/;

function invalid(message: string): never {
  throw new TypeError(`Meta.fonts: ${message}`);
}

/** The format a url's extension implies (`.woff2` → `"woff2"`), ignoring query and hash. */
export function fontFormatOf(url: string): FontFormat | null {
  const file = (url.split(/[?#]/)[0] ?? "").split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  return dot === -1 ? null : (FORMAT_BY_EXTENSION[file.slice(dot + 1).toLowerCase()] ?? null);
}

function descriptor(name: string, value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || !DESCRIPTOR.test(text)) {
    invalid(`${name} ${JSON.stringify(value)} is not a valid font-${name} value`);
  }
  return text;
}

/** Validates what a handler passed; throws a `TypeError` naming the bad value. */
export function normalizeFonts(fonts: MetaFont[]): NormalizedFont[] {
  if (!Array.isArray(fonts)) invalid("expected an array of fonts");
  return fonts.map((font) => {
    if (typeof font?.family !== "string" || !font.family.trim()) {
      invalid("every font needs a family");
    }
    const sources = typeof font.src === "string" ? [{ url: font.src }] : font.src;
    if (!Array.isArray(sources) || sources.length === 0) {
      invalid(`font "${font.family}" needs a src`);
    }
    const src = sources.map((source) => {
      if (typeof source?.url !== "string" || !source.url.trim()) {
        invalid(`font "${font.family}" has a source without a url`);
      }
      if (source.format !== undefined && !FORMATS.has(source.format)) {
        invalid(`font "${font.family}" has an unknown format ${JSON.stringify(source.format)}`);
      }
      return { url: source.url.trim(), format: source.format ?? fontFormatOf(source.url) };
    });
    const display = font.display ?? "swap";
    if (!DISPLAYS.has(display)) {
      invalid(`display ${JSON.stringify(display)} is not a valid font-display value`);
    }
    const unicodeRange = font.unicodeRange?.trim() || null;
    if (unicodeRange && !UNICODE_RANGE.test(unicodeRange)) {
      invalid(`unicodeRange ${JSON.stringify(font.unicodeRange)} is not a valid unicode-range`);
    }
    return {
      family: font.family.trim(),
      src,
      weight: descriptor("weight", font.weight),
      style: descriptor("style", font.style),
      stretch: descriptor("stretch", font.stretch),
      display,
      unicodeRange,
      preload: font.preload === true,
    };
  });
}

/**
 * A CSS string literal holding `value`. Quotes, backslashes, control
 * characters and `<` (so `</style>` can't close the element) are escaped.
 */
export function cssString(value: string): string {
  // oxlint-disable-next-line no-control-regex -- escaping them is the point
  const escaped = value.replace(/[\\"<>\u0000-\u001f\u007f]/g, (char) =>
    char === "\\" || char === '"' ? `\\${char}` : `\\${char.charCodeAt(0).toString(16)} `,
  );
  return `"${escaped}"`;
}

/** One `@font-face` rule. */
export function fontFaceRule(font: NormalizedFont): string {
  const src = font.src
    .map(({ url, format }) => `url(${cssString(url)})${format ? ` format(${cssString(format)})` : ""}`)
    .join(", ");
  const declarations = [
    `font-family: ${cssString(font.family)}`,
    `src: ${src}`,
    font.weight && `font-weight: ${font.weight}`,
    font.style && `font-style: ${font.style}`,
    font.stretch && `font-stretch: ${font.stretch}`,
    `font-display: ${font.display}`,
    font.unicodeRange && `unicode-range: ${font.unicodeRange}`,
  ].filter(Boolean);
  return `@font-face { ${declarations.join("; ")}; }`;
}

/** The `@font-face` rules for `fonts`, an identical font declared twice once. */
export function fontFaceRules(fonts: NormalizedFont[] | null | undefined): string[] {
  return [...new Set((fonts ?? []).map(fontFaceRule))];
}

/** The first file of every font marked `preload`, each url once. */
export function fontPreloads(fonts: NormalizedFont[] | null | undefined): FontPreload[] {
  const preloads = new Map<string, FontPreload>();
  for (const font of fonts ?? []) {
    const first = font.preload ? font.src[0] : undefined;
    if (first && !preloads.has(first.url)) {
      preloads.set(first.url, {
        href: first.url,
        type: (first.format && MIME_BY_FORMAT[first.format]) ?? null,
      });
    }
  }
  return [...preloads.values()];
}
