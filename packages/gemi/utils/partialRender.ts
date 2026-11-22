/**
 * Route the client is currently rendering, sent on `.json` navigations so the
 * server can skip the handlers of the segments that route already has mounted.
 * Value is a locale-less pathname plus search, e.g. `/app/A/chat?tab=2`.
 */
export const PARTIAL_RENDER_HEADER = "x-gemi-from";

/** What the server reports back about the skip it performed, if any. */
export interface PartialRenderInfo {
  /** The `x-gemi-from` value the plan was computed against. */
  from: string;
  /** View paths of the skipped segments, in order. Their data is carried forward. */
  carriedViews: string[];
}

/**
 * The `x-gemi-from` value for the route the client starts on: the path the
 * router is on, as the browser sent it, plus the search.
 *
 * The router's `pathname` is the concrete path from the first render on
 * (#1134), so nothing is rebuilt from the params. The params are decoded
 * (#1322), and re-encoding them would not give the same path back:
 * `john@x.com` comes back as `john%40x.com`, and a `:` in a concrete path
 * would be read as a param.
 */
export function initialRenderedRoute(route: { pathname?: string; search?: string }) {
  return `${route.pathname || "/"}${route.search ?? ""}`;
}
