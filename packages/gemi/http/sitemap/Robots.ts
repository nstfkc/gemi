import { safeFetch } from "../safeFetch/safeFetch";
import { decodeText, readBytes, type ReaderFetchOptions } from "./fetchText";

/** One group of a robots.txt you write. */
export type RobotsRule = {
  /** The crawler(s) the group is for: a product token such as `"Googlebot"`, or `"*"`. */
  userAgent: string | readonly string[];
  /** Paths (starting with `/`, or `*`) the crawler may fetch, overriding a shorter `disallow`. */
  allow?: string | readonly string[];
  /** Paths the crawler may not fetch. `"/"` is everything. */
  disallow?: string | readonly string[];
  /** Seconds between requests. Not in RFC 9309; Bing and Yandex read it, Google ignores it. */
  crawlDelay?: number;
};

export type RobotsConfig = {
  rules?: readonly RobotsRule[];
  /** Absolute URLs of your sitemaps. */
  sitemaps?: readonly string[];
};

/** A group read from a robots.txt. */
export type RobotsGroup = {
  /** Lower-cased product tokens. */
  userAgents: string[];
  rules: { type: "allow" | "disallow"; path: string }[];
  crawlDelay?: number;
};

export type RobotsFetchOptions = ReaderFetchOptions & {
  /**
   * Bytes of the file read; the rest is ignored, as RFC 9309 lets a crawler
   * do. Default 500 KiB, the least the RFC asks a crawler to read.
   */
  maxSize?: number;
};

/**
 * How the robots.txt was obtained, which decides what an empty or missing
 * file means (RFC 9309, section 2.3.1):
 *
 * - `"parsed"`: a 2xx; its rules apply.
 * - `"unavailable"`: a 4xx other than 429 (usually 404); everything is allowed.
 * - `"unreachable"`: a 5xx or 429; everything is disallowed until it can be read.
 */
export type RobotsStatus = "parsed" | "unavailable" | "unreachable";

const MAX_ROBOTS_SIZE = 500 * 1024;
const encoder = new TextEncoder();

/** The lower-cased product token at the start of a user agent: `Googlebot/2.1` → `googlebot`. */
function productToken(value: string) {
  const trimmed = value.trim();
  if (trimmed === "*") return "*";
  return (/^[a-zA-Z_-]+/.exec(trimmed)?.[0] ?? "").toLowerCase();
}

/**
 * Percent-encodes what isn't already, and upper-cases existing escapes, so a
 * rule and a path written differently compare as the same octets.
 */
function normalizePath(path: string) {
  let out = "";
  for (let index = 0; index < path.length; index++) {
    const char = path[index];
    if (char === "%" && /^[0-9a-fA-F]{2}$/.test(path.slice(index + 1, index + 3))) {
      out += `%${path.slice(index + 1, index + 3).toUpperCase()}`;
      index += 2;
    } else if (char.charCodeAt(0) > 0x7e || char.charCodeAt(0) <= 0x20) {
      const code = path.codePointAt(index)!;
      if (code > 0xffff) index++;
      for (const byte of encoder.encode(String.fromCodePoint(code))) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Whether `pattern` (with `*` for any run of characters and a trailing `$` for
 * the end) matches the start of `path`. Greedy two-pointer matching: no
 * regular expression is built from the file, so no pattern can backtrack
 * exponentially.
 */
function matches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const glob = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (p < glob.length && glob[p] !== "*" && glob[p] === path[s]) {
      p++;
      s++;
    } else if (p < glob.length && glob[p] === "*") {
      star = p++;
      mark = s;
    } else if (p === glob.length && !anchored) {
      return true;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (p < glob.length && glob[p] === "*") p++;
  return p === glob.length;
}

/** A parsed robots.txt. */
export class RobotsTxt {
  constructor(
    readonly groups: RobotsGroup[],
    /** The `Sitemap:` URLs, absolute. */
    readonly sitemaps: string[],
    readonly status: RobotsStatus = "parsed",
  ) {}

  /** The groups that apply to `userAgent`: its own, or else the `*` ones. */
  private groupsFor(userAgent: string) {
    const token = productToken(userAgent) || "*";
    if (token !== "*") {
      const own = this.groups.filter((group) => group.userAgents.includes(token));
      if (own.length > 0) return own;
    }
    return this.groups.filter((group) => group.userAgents.includes("*"));
  }

  /**
   * Whether `userAgent` (its product token, e.g. `"MyCrawler"`; default `"*"`)
   * may fetch a path or URL. The longest matching rule wins, and `allow` wins
   * a tie (RFC 9309). `/robots.txt` itself is always allowed.
   */
  isAllowed(pathOrUrl: string | URL, userAgent = "*"): boolean {
    let path: string;
    if (pathOrUrl instanceof URL || /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) {
      const url = new URL(String(pathOrUrl));
      path = url.pathname + url.search;
    } else {
      path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
    }
    if (path === "/robots.txt") return true;
    if (this.status === "unavailable") return true;
    if (this.status === "unreachable") return false;
    path = normalizePath(path);

    let best: { length: number; allow: boolean } | null = null;
    for (const group of this.groupsFor(userAgent)) {
      for (const rule of group.rules) {
        if (!matches(rule.path, path)) continue;
        const length = rule.path.length;
        const allow = rule.type === "allow";
        if (!best || length > best.length || (length === best.length && allow)) {
          best = { length, allow };
        }
      }
    }
    return best ? best.allow : true;
  }

  /** `Crawl-delay` in seconds for `userAgent`, or `null` when none is set. */
  crawlDelay(userAgent = "*"): number | null {
    for (const group of this.groupsFor(userAgent)) {
      if (group.crawlDelay !== undefined) return group.crawlDelay;
    }
    return null;
  }
}

const KEYS: Record<string, "user-agent" | "allow" | "disallow" | "sitemap" | "crawl-delay"> = {
  "user-agent": "user-agent",
  useragent: "user-agent",
  "user agent": "user-agent",
  allow: "allow",
  disallow: "disallow",
  dissallow: "disallow",
  disalow: "disallow",
  sitemap: "sitemap",
  "site-map": "sitemap",
  "crawl-delay": "crawl-delay",
};

/**
 * Parses a robots.txt (RFC 9309). `url` is where it came from, to resolve
 * relative `Sitemap:` lines; without it they are dropped.
 */
function parse(text: string, options: { url?: string | URL } = {}): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive user-agent lines share one group; a user-agent after rules starts a new one.
  let collectingAgents = false;

  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = KEYS[line.slice(0, colon).trim().toLowerCase()];
    const value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (key === "sitemap") {
      if (!value || /\s/.test(value)) continue;
      try {
        const url = options.url ? new URL(value, options.url) : new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") sitemaps.push(url.href);
      } catch {
        // Not a URL: ignored.
      }
      continue;
    }
    if (key === "user-agent") {
      if (!collectingAgents || !current) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      const token = productToken(value);
      if (token) current.userAgents.push(token);
      continue;
    }
    // A rule before any user-agent line belongs to no group.
    if (!current) continue;
    collectingAgents = false;
    if (key === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
      continue;
    }
    // An empty `Disallow:` disallows nothing; an empty `Allow:` allows nothing extra.
    if (!value) continue;
    current.rules.push({ type: key, path: normalizePath(value) });
  }
  return new RobotsTxt(groups, sitemaps);
}

/**
 * Fetches and parses `<origin>/robots.txt` through `safeFetch`. `site` is any
 * URL on the site. A 4xx answers a `RobotsTxt` that allows everything, a 5xx
 * (or 429) one that disallows everything, as RFC 9309 asks; network failures,
 * timeouts and refused addresses throw the `SafeFetchError`.
 */
async function fetchRobots(
  site: string | URL,
  options: RobotsFetchOptions = {},
): Promise<RobotsTxt> {
  const { maxSize = MAX_ROBOTS_SIZE, ...fetchOptions } = options;
  const url = new URL("/robots.txt", site);
  // The cap is applied while reading (keeping what fits), not by safeFetch,
  // which would throw and keep nothing.
  const response = await safeFetch(url, { ...fetchOptions, maxSize: Number.MAX_SAFE_INTEGER });
  const status = response.status;
  if (status === 429 || status >= 500) {
    response.body?.cancel().catch(() => {});
    return new RobotsTxt([], [], "unreachable");
  }
  if (status >= 400) {
    response.body?.cancel().catch(() => {});
    return new RobotsTxt([], [], "unavailable");
  }
  const bytes = await readBytes(response, maxSize, true);
  let text = decodeText(bytes);
  // A cut-off last line may be half a rule; drop it.
  if (bytes.byteLength >= maxSize) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  return parse(text, { url: response.url });
}

function list(value: string | readonly string[] | undefined) {
  return value === undefined ? [] : typeof value === "string" ? [value] : value;
}

function line(key: string, value: string) {
  if (/[\r\n]/.test(value)) {
    throw new TypeError(
      `Robots: the ${key} value ${JSON.stringify(value)} has a line break in it.`,
    );
  }
  return `${key}: ${value}\n`;
}

/** The text of a robots.txt. */
function text(config: RobotsConfig): string {
  const blocks: string[] = [];
  for (const rule of config.rules ?? []) {
    const agents = list(rule.userAgent);
    if (agents.length === 0) throw new TypeError("Robots: a rule needs at least one userAgent.");
    let block = agents.map((agent) => line("User-agent", agent)).join("");
    const paths = [
      ...list(rule.allow).map((path) => ["Allow", path] as const),
      ...list(rule.disallow).map((path) => ["Disallow", path] as const),
    ];
    for (const [key, path] of paths) {
      if (!path.startsWith("/") && !path.startsWith("*")) {
        throw new TypeError(`Robots: ${key} "${path}" must start with "/" or "*".`);
      }
      block += line(key, path);
    }
    // A group without rules still needs one line to be a group: an empty Disallow allows everything.
    if (paths.length === 0) block += "Disallow:\n";
    if (rule.crawlDelay !== undefined) {
      if (!Number.isFinite(rule.crawlDelay) || rule.crawlDelay < 0) {
        throw new TypeError(`Robots: crawlDelay ${rule.crawlDelay} is not a number of seconds.`);
      }
      block += line("Crawl-delay", String(rule.crawlDelay));
    }
    blocks.push(block);
  }
  const sitemaps = (config.sitemaps ?? []).map((sitemap) => {
    let url: URL;
    try {
      url = new URL(sitemap);
    } catch {
      throw new TypeError(`Robots: sitemap "${sitemap}" is not an absolute URL.`);
    }
    return line("Sitemap", url.href);
  });
  if (sitemaps.length > 0) blocks.push(sitemaps.join(""));
  return blocks.join("\n");
}

/** The `text/plain` answer for `/robots.txt`. */
function response(config: RobotsConfig, options: { headers?: HeadersInit } = {}): Response {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(text(config), { status: 200, headers });
}

/**
 * robots.txt: writing one (`response`, `text`) and reading one (`fetch`,
 * `parse`).
 */
export const Robots = {
  response,
  text,
  parse,
  fetch: fetchRobots,
} as const;
