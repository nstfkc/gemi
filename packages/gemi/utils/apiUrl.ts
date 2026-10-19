import { API_PREFIX } from "../services/router/apiPath";

type ParamValue = string | number | readonly (string | number)[] | undefined;

function encodeSegments(value: string | number | readonly (string | number)[]) {
  const parts = Array.isArray(value) ? value : String(value).split("/");
  return parts.map((part) => encodeURIComponent(String(part))).join("/");
}

/**
 * An api route's path with its params filled in and encoded, under `/api`:
 * `/pages/:pageId` with `{ pageId: "a b" }` is `/api/pages/a%20b`.
 *
 * Each value is `encodeURIComponent`-ed, so a `/` or `?` in a value stays in
 * its segment. A wildcard (`:path*`) takes a string, whose `/`s are kept, or
 * an array of segments. An optional param (`:id?`) left out drops its segment.
 * A required param left out throws.
 */
export function apiUrl(key: string, params: Record<string, ParamValue> = {}): string {
  const path = key.replace(/\/:(\w+)([*?]?)/g, (_, name: string, suffix: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined || value === "") {
      if (suffix) return "";
      throw new Error(`\`${key}\` needs a value for :${name}.`);
    }
    return `/${suffix === "*" ? encodeSegments(value) : encodeURIComponent(String(value))}`;
  });
  return `${API_PREFIX}${path === "/" ? "" : path}` || API_PREFIX;
}

const patterns = new Map<string, URLPattern>();

/**
 * The params of `url` when it is the api route `key`'s URL, decoded, or null.
 * `url` may be absolute (any origin) or a path, and its query and hash are
 * ignored. The inverse of `apiUrl`.
 */
export function matchApiUrl(key: string, url: string): Record<string, string> | null {
  let pattern = patterns.get(key);
  if (!pattern) {
    pattern = new URLPattern({ pathname: `${API_PREFIX}${key === "/" ? "" : key}` });
    patterns.set(key, pattern);
  }
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const groups = pattern.exec({ pathname })?.pathname.groups;
  if (!groups) return null;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(groups)) {
    if (value === undefined) continue;
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return params;
}
