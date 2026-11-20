import { applyParams } from "./applyParams";

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
 * The `x-gemi-from` value for the route the client starts on.
 *
 * On the first render the router's `pathname` is still the route *pattern* the
 * server matched — it only becomes a resolved path once the history listener
 * has run — so this has to apply the params. Sending `/app/:orgId/chat` names
 * no route the server can resolve, and the first navigation after every full
 * page load would skip nothing.
 */
export function initialRenderedRoute(route: {
  pathname?: string;
  params?: Record<string, string>;
  search?: string;
}) {
  // `applyParams` strips the trailing slash, so the root route resolves to the
  // empty string — which the server reads as "no header" and renders in full.
  const pathname = applyParams(route.pathname ?? "/", route.params ?? {}) || "/";
  return `${pathname}${route.search ?? ""}`;
}
