import type { AlternateLink } from "../Metadata";
import { safeFetch } from "../safeFetch/safeFetch";
import { decodeText, readBytes, type ReaderFetchOptions } from "./fetchText";
import { escapeXml, scanXml } from "./xml";

export type SitemapChangeFreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

/** One page in a sitemap. */
export type SitemapEntry = {
  /** The page's absolute http(s) URL. */
  loc: string;
  /** When the page last changed: a `Date`, or a W3C datetime such as `"2026-10-07"`. */
  lastmod?: Date | string | null;
  changefreq?: SitemapChangeFreq | null;
  /** From 0 to 1. */
  priority?: number | null;
  /**
   * The same page in other languages, written as `<xhtml:link rel="alternate">`.
   * List every language version, this page's own included, as Google expects.
   */
  alternates?: readonly AlternateLink[] | null;
};

/** One sitemap in a sitemap index. */
export type SitemapIndexEntry = {
  loc: string;
  lastmod?: Date | string | null;
};

/** A page read from a sitemap. Values are as the file wrote them. */
export type SitemapUrl = {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
  alternates?: AlternateLink[];
};

export type ParsedSitemap =
  | { kind: "urlset"; urls: SitemapUrl[] }
  | { kind: "index"; sitemaps: { loc: string; lastmod?: string }[] };

export type SitemapLimits = {
  /** URLs per sitemap file. Default (and the protocol's maximum) 50 000. */
  maxUrls?: number;
  /** Bytes per sitemap file, uncompressed. Default (and the protocol's maximum) 50 MB (52 428 800). */
  maxBytes?: number;
};

export type SitemapResponseOptions = SitemapLimits & {
  /**
   * Which file to answer, 1-based, usually `req.search.get("page")`. Empty
   * answers the sitemap itself: the only file when everything fits in one, or
   * the index of the files when it doesn't.
   */
  page?: number | string | null;
  /**
   * The absolute URL of file `page`, for the index. Required once the entries
   * don't fit in one file: `(page) => \`https://example.com/sitemap.xml?page=${page}\``.
   */
  pageUrl?: (page: number) => string;
  /** Extra headers, e.g. `Cache-Control`. */
  headers?: HeadersInit;
};

export type SitemapReadOptions = ReaderFetchOptions & {
  /** URLs yielded in all, after which reading stops. Default 50 000. */
  maxUrls?: number;
  /** Sitemap files fetched in all, the indexes included. Default 50. */
  maxSitemaps?: number;
  /**
   * Levels of sitemap index followed. Default 3. The protocol allows one (an
   * index lists sitemaps), but nested indexes exist in the wild.
   */
  maxDepth?: number;
  /** Largest file, in bytes after decompression (gzip included). Default 50 MB. */
  maxSize?: number;
  /**
   * Called when a sitemap listed in an index fails (a 404, a timeout, a file
   * that isn't a sitemap), which is then skipped. Without it, the error is
   * thrown. A failure of the first URL is always thrown.
   */
  onError?: (error: unknown, url: string) => void;
};

/** A sitemap that couldn't be read or parsed, or entries that can't be written. */
export class SitemapError extends Error {
  constructor(
    message: string,
    /** The sitemap's URL, when one was being read. */
    readonly url: string | null = null,
    /** The HTTP status, when the server answered with an error. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SitemapError";
  }
}

const NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const URLSET_OPEN = `<urlset xmlns="${NAMESPACE}" xmlns:xhtml="${XHTML_NAMESPACE}">\n`;
const URLSET_CLOSE = "</urlset>\n";
const MAX_URLS = 50_000;
const MAX_BYTES = 52_428_800;
const MAX_LOC_LENGTH = 2048;
const CHANGEFREQS = new Set(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);
const W3C_DATETIME = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;
const XML_CONTENT_TYPE = "application/xml; charset=utf-8";

const encoder = new TextEncoder();

function absoluteUrl(value: string, what: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SitemapError(`Sitemap: ${what} "${value}" is not an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SitemapError(`Sitemap: ${what} "${value}" is not an http(s) URL.`);
  }
  // `href` percent-encodes what a URL can't carry raw (spaces, non-ASCII paths)
  // and punycodes the host, as the protocol asks.
  const href = url.href;
  if (href.length > MAX_LOC_LENGTH) {
    throw new SitemapError(
      `Sitemap: ${what} is over ${MAX_LOC_LENGTH} characters: "${href.slice(0, 80)}…".`,
    );
  }
  return href;
}

function formatDate(value: Date | string, loc: string) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new SitemapError(`Sitemap: lastmod of ${loc} is an invalid Date.`);
    }
    return value.toISOString();
  }
  if (!W3C_DATETIME.test(value)) {
    throw new SitemapError(
      `Sitemap: lastmod "${value}" of ${loc} is not a W3C datetime (e.g. "2026-10-07" or "2026-10-07T12:00:00Z").`,
    );
  }
  return value;
}

function renderUrl(entry: SitemapEntry) {
  const loc = absoluteUrl(entry.loc, "loc");
  let xml = `<url><loc>${escapeXml(loc)}</loc>`;
  if (entry.lastmod != null)
    xml += `<lastmod>${escapeXml(formatDate(entry.lastmod, loc))}</lastmod>`;
  if (entry.changefreq != null) {
    if (!CHANGEFREQS.has(entry.changefreq)) {
      throw new SitemapError(
        `Sitemap: changefreq "${entry.changefreq}" of ${loc} is not one the protocol knows.`,
      );
    }
    xml += `<changefreq>${entry.changefreq}</changefreq>`;
  }
  if (entry.priority != null) {
    const priority = entry.priority;
    if (!Number.isFinite(priority) || priority < 0 || priority > 1) {
      throw new SitemapError(`Sitemap: priority ${priority} of ${loc} is not between 0 and 1.`);
    }
    xml += `<priority>${Number(priority.toFixed(4))}</priority>`;
  }
  for (const alternate of entry.alternates ?? []) {
    const hrefLang = alternate.hrefLang?.trim();
    if (!hrefLang) throw new SitemapError(`Sitemap: an alternate of ${loc} has no hrefLang.`);
    const href = absoluteUrl(alternate.href, `alternate href of ${loc}`);
    xml += `<xhtml:link rel="alternate" hreflang="${escapeXml(hrefLang)}" href="${escapeXml(href)}"/>`;
  }
  return `${xml}</url>\n`;
}

function limits(options: SitemapLimits) {
  const maxUrls = options.maxUrls ?? MAX_URLS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > MAX_URLS) {
    throw new RangeError(`Sitemap: maxUrls must be an integer from 1 to ${MAX_URLS}.`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new RangeError(`Sitemap: maxBytes must be an integer from 1 to ${MAX_BYTES}.`);
  }
  return { maxUrls, maxBytes };
}

/**
 * The entries as `<urlset>` documents, as many as the limits need. Each is a
 * complete sitemap file.
 */
function chunk(entries: Iterable<SitemapEntry>, options: SitemapLimits = {}): string[] {
  const { maxUrls, maxBytes } = limits(options);
  const frame = encoder.encode(XML_DECLARATION + URLSET_OPEN + URLSET_CLOSE).byteLength;
  const files: string[] = [];
  let parts: string[] = [];
  let bytes = frame;
  const flush = () => {
    files.push(XML_DECLARATION + URLSET_OPEN + parts.join("") + URLSET_CLOSE);
    parts = [];
    bytes = frame;
  };
  for (const entry of entries) {
    const xml = renderUrl(entry);
    const size = encoder.encode(xml).byteLength;
    if (frame + size > maxBytes) {
      throw new SitemapError(
        `Sitemap: the entry for ${entry.loc} alone is over maxBytes (${maxBytes}).`,
      );
    }
    if (parts.length === maxUrls || bytes + size > maxBytes) flush();
    parts.push(xml);
    bytes += size;
  }
  if (parts.length > 0 || files.length === 0) flush();
  return files;
}

/** A `<sitemapindex>` document listing sitemap files. */
function index(sitemaps: Iterable<SitemapIndexEntry>): string {
  let body = "";
  let count = 0;
  for (const sitemap of sitemaps) {
    if (++count > MAX_URLS) {
      throw new SitemapError(`Sitemap: an index can list at most ${MAX_URLS} sitemaps.`);
    }
    const loc = absoluteUrl(sitemap.loc, "sitemap loc");
    body += `<sitemap><loc>${escapeXml(loc)}</loc>`;
    if (sitemap.lastmod != null) {
      body += `<lastmod>${escapeXml(formatDate(sitemap.lastmod, loc))}</lastmod>`;
    }
    body += "</sitemap>\n";
  }
  return `${XML_DECLARATION}<sitemapindex xmlns="${NAMESPACE}">\n${body}</sitemapindex>\n`;
}

function xmlResponse(body: string, status: number, headers?: HeadersInit) {
  const all = new Headers(headers);
  if (!all.has("content-type")) all.set("content-type", XML_CONTENT_TYPE);
  return new Response(body, { status, headers: all });
}

function parsePage(page: number | string | null | undefined) {
  if (page === null || page === undefined || page === "") return null;
  const text = String(page);
  return /^[1-9]\d{0,8}$/.test(text) ? Number(text) : NaN;
}

/**
 * The XML answer for `/sitemap.xml`. Entries that fit in one file (50 000 URLs
 * and 50 MB, or `maxUrls`/`maxBytes`) answer one `<urlset>`. Past that, the
 * route answers a `<sitemapindex>` of `pageUrl(1)`, `pageUrl(2)`, …, and
 * `page` picks which file to answer; a page that doesn't exist is a 404.
 */
function response(entries: Iterable<SitemapEntry>, options: SitemapResponseOptions = {}): Response {
  const files = chunk(entries, options);
  const page = parsePage(options.page);
  if (page !== null) {
    const file = files[page - 1];
    return file
      ? xmlResponse(file, 200, options.headers)
      : new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (files.length === 1) return xmlResponse(files[0], 200, options.headers);
  const pageUrl = options.pageUrl;
  if (!pageUrl) {
    throw new SitemapError(
      `Sitemap: the entries need ${files.length} files, so Sitemap.response needs \`pageUrl\` to list them in an index.`,
    );
  }
  return xmlResponse(index(files.map((_, i) => ({ loc: pageUrl(i + 1) }))), 200, options.headers);
}

function httpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A sitemap's text: a `<urlset>`, a `<sitemapindex>`, or a plain-text sitemap
 * (one URL per line). Entries whose `loc` isn't an absolute http(s) URL are
 * left out. Throws `SitemapError` for anything else, e.g. an HTML page.
 */
function parse(text: string, options: { maxUrls?: number } = {}): ParsedSitemap {
  const maxUrls = options.maxUrls ?? Infinity;
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (!trimmed.startsWith("<")) {
    const urls: SitemapUrl[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (urls.length >= maxUrls) break;
      const loc = line.trim() ? httpUrl(line) : null;
      if (loc) urls.push({ loc });
    }
    if (urls.length === 0 && trimmed.length > 0) {
      throw new SitemapError("Sitemap: the document is neither XML nor a list of URLs.");
    }
    return { kind: "urlset", urls };
  }

  let kind = null as "urlset" | "index" | null;
  const urls: SitemapUrl[] = [];
  const sitemaps: { loc: string; lastmod?: string }[] = [];
  const stack: string[] = [];
  let current: {
    loc?: string;
    lastmod?: string;
    changefreq?: string;
    priority?: string;
    alternates?: AlternateLink[];
  } | null = null;
  let field: "loc" | "lastmod" | "changefreq" | "priority" | null = null;
  let value = "";
  const count = () => (kind === "index" ? sitemaps.length : urls.length);

  scanXml(trimmed, {
    stopped: () => count() >= maxUrls,
    open(name, attributes) {
      const parent = stack[stack.length - 1];
      stack.push(name);
      if (kind === null) {
        if (name === "urlset") kind = "urlset";
        else if (name === "sitemapindex") kind = "index";
        return;
      }
      if (
        (kind === "urlset" && name === "url" && parent === "urlset") ||
        (kind === "index" && name === "sitemap" && parent === "sitemapindex")
      ) {
        current = {};
      } else if (
        current &&
        (parent === "url" || parent === "sitemap") &&
        (name === "loc" || name === "lastmod" || name === "changefreq" || name === "priority")
      ) {
        field = name;
        value = "";
      } else if (current && kind === "urlset" && parent === "url" && name === "link") {
        const href = attributes.href ? httpUrl(attributes.href) : null;
        if (attributes.rel?.toLowerCase() === "alternate" && attributes.hreflang && href) {
          (current.alternates ??= []).push({ hrefLang: attributes.hreflang, href });
        }
      }
    },
    close(name) {
      // Lenient about mismatched tags: unwind to the nearest open one by that name.
      const at = stack.lastIndexOf(name);
      if (at === -1) return;
      stack.length = at;
      if (field && name === field && current) {
        current[field] = value.trim();
        field = null;
      } else if (current && (name === "url" || name === "sitemap")) {
        const entry: {
          loc?: string;
          lastmod?: string;
          changefreq?: string;
          priority?: string;
          alternates?: AlternateLink[];
        } = current;
        current = null;
        field = null;
        const loc = entry.loc ? httpUrl(entry.loc) : null;
        if (!loc) return;
        if (kind === "index") {
          sitemaps.push(entry.lastmod ? { loc, lastmod: entry.lastmod } : { loc });
          return;
        }
        const url: SitemapUrl = { loc };
        if (entry.lastmod) url.lastmod = entry.lastmod;
        if (entry.changefreq) url.changefreq = entry.changefreq;
        const priority = entry.priority ? Number(entry.priority) : NaN;
        if (Number.isFinite(priority)) url.priority = priority;
        if (entry.alternates) url.alternates = entry.alternates;
        urls.push(url);
      }
    },
    text(chunk) {
      if (field) value += chunk;
    },
  });

  if (kind === null) {
    throw new SitemapError("Sitemap: the document has no <urlset> or <sitemapindex>.");
  }
  return kind === "index" ? { kind, sitemaps } : { kind, urls };
}

/**
 * Reads a sitemap from the web through `safeFetch`, yielding its pages and
 * following sitemap indexes (depth-first, in order). Stops after `maxUrls`
 * pages or `maxSitemaps` files, never fetches a file twice, and handles gzip.
 *
 * ```ts
 * for await (const page of Sitemap.read("https://example.com/sitemap.xml", { maxUrls: 500 })) {
 *   page.loc; page.lastmod; page.alternates; page.sitemap;
 * }
 * ```
 */
async function* read(
  url: string | URL,
  options: SitemapReadOptions = {},
): AsyncGenerator<SitemapUrl & { sitemap: string }, void, undefined> {
  const {
    maxUrls = MAX_URLS,
    maxSitemaps = 50,
    maxDepth = 3,
    maxSize = MAX_BYTES,
    onError,
    ...fetchOptions
  } = options;
  let queue: { url: string; depth: number }[] = [{ url: String(url), depth: 0 }];
  const seen = new Set<string>();
  let fetched = 0;
  let yielded = 0;

  while (queue.length > 0 && yielded < maxUrls && fetched < maxSitemaps) {
    const item = queue.shift()!;
    const key = item.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    fetched++;

    let document: ParsedSitemap;
    try {
      const response = await safeFetch(item.url, { ...fetchOptions, maxSize });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        throw new SitemapError(
          `Sitemap: ${item.url} answered ${response.status}.`,
          item.url,
          response.status,
        );
      }
      const text = decodeText(await readBytes(response, maxSize));
      // Enough of either kind for what is left to read; the rest of the file is not scanned.
      document = parse(text, { maxUrls: Math.max(maxUrls - yielded, maxSitemaps - fetched) });
    } catch (error) {
      if (item.depth === 0 || !onError || fetchOptions.signal?.aborted) throw error;
      onError(error, item.url);
      continue;
    }

    if (document.kind === "index") {
      if (item.depth >= maxDepth) continue;
      const children = document.sitemaps
        .slice(0, maxSitemaps - fetched)
        .map((sitemap) => ({ url: sitemap.loc, depth: item.depth + 1 }));
      queue = children.concat(queue);
      continue;
    }
    for (const entry of document.urls) {
      yield { ...entry, sitemap: item.url };
      if (++yielded >= maxUrls) return;
    }
  }
}

/**
 * sitemap.xml: writing one (`response`, `chunk`, `index`), and reading one
 * (`parse`, `read`).
 */
export const Sitemap = {
  response,
  chunk,
  index,
  parse,
  read,
  /** Limits the protocol sets per file. */
  MAX_URLS,
  MAX_BYTES,
} as const;
