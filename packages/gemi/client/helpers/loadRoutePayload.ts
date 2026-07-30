import {
  PARTIAL_RENDER_HEADER,
  type PartialRenderInfo,
} from "../../utils/partialRender";

interface LoadRoutePayloadOptions {
  /** The `.json` URL for the route being navigated to. */
  url: string;
  /** `x-gemi-from` value for the route currently on screen. */
  from: string;
  /** Hands over a payload warmed ahead of this navigation, if there is one. */
  takePrefetched?: (url: string) => Promise<unknown> | null;
  /**
   * The route that is on screen *now*, re-read at the moment a response lands.
   * A navigation that committed while this one was in flight invalidates the
   * partial-render plan the server computed.
   */
  renderedRoute: () => string;
}

/**
 * The page data for a navigation, from whichever source can produce it.
 *
 * A prefetched payload is always a full render, so it can be committed as-is
 * and the `x-gemi-from` round trip skipped entirely. Everything else — no
 * prefetch, a prefetch that failed, a partial response computed against a route
 * that has since been navigated away from — falls through to a request.
 *
 * Returns `null` when nothing usable came back; the caller leaves the current
 * route on screen.
 */
export async function loadRoutePayload(
  options: LoadRoutePayloadOptions,
): Promise<any> {
  const { url, from, takePrefetched, renderedRoute } = options;

  const prefetched = takePrefetched?.(url);
  if (prefetched) {
    const payload = await prefetched;
    if (payload) {
      return payload;
    }
  }

  let response = { ok: false, json: async () => ({}) } as Response;
  try {
    response = await fetch(url, { headers: { [PARTIAL_RENDER_HEADER]: from } });
  } catch (e) {
    console.error(e);
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();

  // The segments the server carried forward were computed against a route that
  // is no longer on screen. Nothing sound to merge onto — ask for the whole
  // tree instead.
  const claimed: PartialRenderInfo | null = payload?.partial ?? null;
  if (claimed && claimed.from !== renderedRoute()) {
    try {
      const full = await fetch(url);
      if (full.ok) {
        return await full.json();
      }
    } catch (e) {
      console.error(e);
    }
  }

  return payload;
}
