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
