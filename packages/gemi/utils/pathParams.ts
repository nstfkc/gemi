/**
 * Decode route captures after matching, so an encoded slash stays in its
 * parameter: `/notes/:id` matched against `/notes/a%2Fb` captures `a%2Fb`,
 * which decodes once to `a/b`. Null when a capture is a malformed escape.
 * API routes (#997) and view routes (#1322) share this rule. `applyParams`
 * is its inverse.
 */
export function decodePathParams(
  groups: Record<string, string | undefined>,
): Record<string, string> | null {
  const params: [string, string][] = [];
  try {
    for (const [name, value] of Object.entries(groups)) {
      if (value !== undefined) params.push([name, decodeURIComponent(value)]);
    }
  } catch {
    return null;
  }
  return Object.fromEntries(params);
}

/**
 * One spelling per path, so `/u/john@x.com`, as a browser sends it, and
 * `/u/john%40x.com`, as `applyParams` builds it, compare equal. Works per
 * segment, so `%2F` stays inside its segment, and leaves a search or hash after
 * the path alone. For comparing only: view data is keyed by the path as sent.
 */
export function canonicalPath(href: string): string {
  const end = href.search(/[?#]/);
  const path = end === -1 ? href : href.slice(0, end);
  const canonical = path
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return segment;
      }
    })
    .join("/");
  return end === -1 ? canonical : canonical + href.slice(end);
}
