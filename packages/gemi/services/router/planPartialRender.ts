import { applyParams } from "../../utils/applyParams";
import type { FlatViewRoutes, ViewRouteSegment } from "./createFlatViewRoutes";
import { matchViewRoute } from "./matchViewRoute";

/** A route, as matched for one request, in the terms partial rendering needs. */
export interface PartialRenderRoute {
  segments: ViewRouteSegment[];
  params: Record<string, string>;
  search: string;
}

export interface PartialRenderPlan {
  /** Index of the first segment whose handler has to run. */
  startIndex: number;
  /** View paths of the segments that were skipped, in order. */
  carriedViews: string[];
}

const NOTHING_SKIPPED: PartialRenderPlan = { startIndex: 0, carriedViews: [] };

function resolve(segment: ViewRouteSegment, params: Record<string, string>) {
  const resolved = applyParams(segment.path, params);
  // `applyParams` only substitutes `:name`. A bare `*` survives, and two
  // different URLs would then compare equal — never skip such a segment.
  return resolved.includes("*") ? null : resolved;
}

/**
 * Works out which of the target route's segments the client already has
 * rendered, and so which of its handlers this request can skip.
 *
 * A segment is carried forward only when it is *the same segment on the same
 * resolved path*: `/app/A/chat` → `/app/A/lists` reuses the layout, but
 * `/app/A/chat` → `/app/B/chat` re-runs it even though the view is the same.
 *
 * The target's own leaf always runs — navigating to the URL you are already on
 * is a reload, not a no-op.
 */
export function planPartialRender(
  from: PartialRenderRoute | null,
  to: PartialRenderRoute,
): PartialRenderPlan {
  if (!from) {
    return NOTHING_SKIPPED;
  }

  // Handlers read `req.search`, and there is no way to know which ones do.
  if (from.search !== to.search) {
    return NOTHING_SKIPPED;
  }

  const limit = Math.min(from.segments.length, to.segments.length - 1);

  let startIndex = 0;
  while (startIndex < limit) {
    const fromSegment = from.segments[startIndex];
    const toSegment = to.segments[startIndex];

    // This layout asked to run on every navigation underneath it. Segments are
    // skipped as a prefix, so everything from here down runs too.
    if (toSegment.alwaysRun) break;

    if (fromSegment.viewPath !== toSegment.viewPath) break;

    const fromPath = resolve(fromSegment, from.params);
    const toPath = resolve(toSegment, to.params);
    if (fromPath === null || toPath === null || fromPath !== toPath) break;

    startIndex++;
  }

  if (startIndex === 0) {
    return NOTHING_SKIPPED;
  }

  return {
    startIndex,
    carriedViews: to.segments.slice(0, startIndex).map(({ viewPath }) => viewPath),
  };
}

function stripLocaleSegment(pathname: string, supportedLocales: string[]) {
  const [, maybeLocale, ...rest] = pathname.split("/");
  if (!supportedLocales.includes(maybeLocale)) {
    return pathname;
  }
  const stripped = `/${rest.join("/")}`;
  return stripped === "/" ? "/" : stripped.replace(/\/$/, "");
}

/**
 * Turns the `x-gemi-from` header into a plan for the request being served.
 *
 * Every way of not knowing what the client has — no header, an unparseable
 * one, a path this server does not route — ends in the same place: render
 * everything. The client is telling the server what to skip, so the failure
 * mode has to be doing the work, never trusting a value that did not check out.
 */
export function resolvePartialRender(options: {
  flatViewRoutes: FlatViewRoutes;
  supportedLocales: string[];
  /** Raw `x-gemi-from` value. */
  from: string | null;
  /** Origin to resolve the header value against. */
  origin: string;
  to: PartialRenderRoute;
}): PartialRenderPlan {
  const { flatViewRoutes, supportedLocales, from, origin, to } = options;

  if (!from) {
    return NOTHING_SKIPPED;
  }

  let url: URL;
  try {
    url = new URL(from, origin);
  } catch {
    return NOTHING_SKIPPED;
  }

  // The client sends a path. Anything that resolved somewhere else was not one.
  if (url.origin !== origin) {
    return NOTHING_SKIPPED;
  }

  const match = matchViewRoute(flatViewRoutes, stripLocaleSegment(url.pathname, supportedLocales));

  if (!match) {
    return NOTHING_SKIPPED;
  }

  return planPartialRender(
    { segments: match.route.segments, params: match.params, search: url.search },
    to,
  );
}
