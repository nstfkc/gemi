/**
 * Joins a route's resolved path, its search (as `URLSearchParams.toString()`
 * gives it, without the `?`) and its hash (with its `#`) into the href that
 * `useNavigate` pushes and `Link` renders.
 *
 * The root route arrives as an empty path, because `applyParams` drops the
 * trailing slash. It has to come back as `/` before anything is appended:
 * `a=1` or `#x` on their own are relative URLs the browser resolves against
 * the current page (#1257).
 */
export function routeHref(path: string, search: string, hash = ""): string {
  return `${path || "/"}${search ? `?${search}` : ""}${hash}`;
}
