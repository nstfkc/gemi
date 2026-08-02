/**
 * The `.json` URL a route's page data is served from.
 *
 * Prefetching and navigation have to agree on this string exactly — the
 * prefetch cache is keyed by it, and any disagreement silently turns every
 * prefetch into a wasted request plus a full fetch on click.
 */
export function routeDataUrl(options: {
  /** Concrete pathname, without the locale segment. */
  pathname: string;
  /** Query string including the leading `?`, or empty. */
  search?: string;
  /** `/tr-TR` style prefix, or empty for the default locale. */
  localeSegment?: string;
}) {
  const { pathname, search = "", localeSegment = "" } = options;
  // `/tr-TR/.json` names nothing — the locale segment is the whole path there.
  const path = localeSegment.length > 0 && pathname === "/" ? "" : pathname;
  return `${localeSegment}${path}.json${search}`;
}
