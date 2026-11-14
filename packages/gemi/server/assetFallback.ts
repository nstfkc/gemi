/**
 * A second place to find a build asset this server does not have (#1269).
 *
 * While two releases serve one app (a weighted rollout across revisions, two
 * origins behind a load balancer with no affinity), a document from one
 * release asks for its hashed files and each request can land on the other.
 * Neither release has the other's files, and a reload only rolls the dice
 * again. With a fallback base set — a bucket or blob container the deploy
 * uploads every release's `dist/client/assets` to before it takes traffic —
 * a miss under `/assets/` is fetched from there and streamed back, so any
 * release answers any recent release's chunks, stylesheets and fonts. Without
 * a file there either, the miss is answered as before (the reload stub for a
 * chunk, a 404 for the rest).
 *
 * Read at boot from `GEMI_ASSET_FALLBACK_URL`. Unset, nothing changes.
 */

/** How long the fallback may take to start answering before the miss is answered locally. */
export const ASSET_FALLBACK_TIMEOUT_MS = 3_000;
/** How long a path the fallback did not have is not asked for again. */
export const ASSET_FALLBACK_MISS_TTL_MS = 30_000;
/** At most this many remembered misses, oldest dropped first. */
const MAX_REMEMBERED_MISSES = 1_000;

/** Marks a response that came from the fallback, for whoever debugs a deploy. */
export const ASSET_FALLBACK_HEADER = "x-gemi-asset-fallback";

export interface AssetFallbackOptions {
  /** Absolute http(s) URL the `/assets/...` path is resolved against. */
  base: string;
  timeoutMs?: number;
  missTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export type AssetFallback = (req: Request, pathname: string) => Promise<Response | undefined>;

/**
 * `GEMI_ASSET_FALLBACK_URL`, checked: an absolute http(s) URL, given a
 * trailing `/`. Anything else is reported and ignored, since a typo must not
 * cost the server its boot.
 */
export function assetFallbackBase(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
    url.search = "";
    url.hash = "";
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  } catch {
    console.error(
      `GEMI_ASSET_FALLBACK_URL is not an absolute http(s) URL (${JSON.stringify(raw)}); missing assets are not looked up anywhere else.`,
    );
    return undefined;
  }
}

/**
 * The lookup for one fallback base. Answers `undefined` whenever the fallback
 * has nothing usable — a non-200, a timeout, a network error, a method other
 * than GET/HEAD — and remembers that for `missTtlMs`, so a path that is
 * really gone (an old tab days later, a scanner) costs the fallback one
 * request per window, not one per hit.
 */
export function createAssetFallback({
  base,
  timeoutMs = ASSET_FALLBACK_TIMEOUT_MS,
  missTtlMs = ASSET_FALLBACK_MISS_TTL_MS,
  fetch: fetchImpl = fetch,
  now = Date.now,
}: AssetFallbackOptions): AssetFallback {
  const misses = new Map<string, number>();

  const remember = (pathname: string) => {
    misses.delete(pathname);
    misses.set(pathname, now() + missTtlMs);
    if (misses.size > MAX_REMEMBERED_MISSES) {
      misses.delete(misses.keys().next().value!);
    }
  };

  return async (req, pathname) => {
    if (req.method !== "GET" && req.method !== "HEAD") return undefined;

    const until = misses.get(pathname);
    if (until !== undefined) {
      if (until > now()) return undefined;
      misses.delete(pathname);
    }

    // The path is the request's own, already normalised by `URL`; resolved
    // relative to the base (without its leading `/`) so a base with a path
    // keeps it, and checked to stay under it.
    let target: URL;
    try {
      target = new URL(pathname.replace(/^\/+/, ""), base);
    } catch {
      return undefined;
    }
    if (!target.href.startsWith(base)) return undefined;

    // The timeout covers the wait for the answer to start, not the body: a
    // large file that has started streaming is left to finish.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetchImpl(target.href, {
        method: req.method,
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      remember(pathname);
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    if (upstream.status !== 200) {
      // Drained so the connection can be reused.
      upstream.body?.cancel().catch(() => {});
      remember(pathname);
      return undefined;
    }

    // The extension decides first, as it does for the files this server has:
    // a store that labels a chunk `application/octet-stream` would otherwise
    // get it refused as a module script.
    const byExtension = Bun.file(pathname).type;
    const headers = new Headers({
      "Content-Type":
        (byExtension !== "application/octet-stream" && byExtension) ||
        upstream.headers.get("content-type") ||
        "application/octet-stream",
      // Content-hashed, like every file the build writes under `/assets/`.
      "Cache-Control": "public, max-age=31536000, immutable",
      [ASSET_FALLBACK_HEADER]: "1",
    });
    // `fetch` decodes a compressed answer, so the upstream length only holds
    // for one that was not encoded.
    const length = upstream.headers.get("content-length");
    if (length && !upstream.headers.get("content-encoding")) {
      headers.set("Content-Length", length);
    }
    return new Response(req.method === "HEAD" ? null : upstream.body, { status: 200, headers });
  };
}
