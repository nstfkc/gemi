import type { Breadcrumb } from "../useBreadcrumbs";

interface RouteSnapshot {
  /** Concrete pathname, without the locale segment. */
  pathname: string;
  /** Route pattern the data was produced for — part of every breadcrumb key. */
  routePath: string;
  data: Record<string, any>;
  breadcrumbs: Record<string, Breadcrumb>;
}

/**
 * A partially rendered response only carries the segments the server actually
 * ran. Everything is keyed by the *new* pathname, so a carried layout would
 * render with empty props unless the data it already had is copied across.
 *
 * Data the server sent always wins: a carried view is only filled in where the
 * response has nothing for it.
 */
export function mergeCarriedSegments(
  previous: RouteSnapshot,
  next: RouteSnapshot,
  carriedViews: string[],
) {
  if (carriedViews.length === 0) {
    return { data: next.data, breadcrumbs: next.breadcrumbs };
  }

  // Page data is keyed by the pathname it was fetched for, and a shallow
  // navigation moves the pathname on without fetching — so fall back to the key
  // the data is actually under. The server sends exactly one.
  const previousData = previous.data ?? {};
  const previousViewData =
    previousData[previous.pathname] ?? previousData[Object.keys(previousData)[0]] ?? {};
  const previousBreadcrumbs = previous.breadcrumbs ?? {};

  const carriedViewData: Record<string, unknown> = {};
  const carriedBreadcrumbs: Record<string, Breadcrumb> = {};

  for (const viewPath of carriedViews) {
    if (viewPath in previousViewData) {
      carriedViewData[viewPath] = previousViewData[viewPath];
    }
    // Breadcrumbs are keyed by route pattern, and that changed even though the
    // segment did not, so they have to be re-keyed rather than copied.
    const previousKey = `${viewPath}:${previous.routePath}`;
    if (previousKey in previousBreadcrumbs) {
      carriedBreadcrumbs[`${viewPath}:${next.routePath}`] = previousBreadcrumbs[previousKey];
    }
  }

  // The server sends page data under exactly one key. Take it from the payload
  // rather than recomputing it, so the two never disagree on spelling.
  const [nextKey = next.pathname] = Object.keys(next.data ?? {});

  return {
    data: {
      ...next.data,
      [nextKey]: { ...carriedViewData, ...next.data?.[nextKey] },
    },
    breadcrumbs: { ...carriedBreadcrumbs, ...next.breadcrumbs },
  };
}
