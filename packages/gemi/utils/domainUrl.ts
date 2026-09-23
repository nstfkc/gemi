/** Which host a cross-domain URL points at. */
export interface DomainTarget {
  /** A subdomain of `route.domains.root` — `"acme"`, `"admin"`. `null` or omitted for the apex. */
  subdomain?: string | null;
  /** A whole hostname instead, for a custom domain. Wins over `subdomain`. */
  host?: string;
}

/** An `http(s)://` URL — what `domainUrl` returns. */
export type AbsoluteUrl = `http://${string}` | `https://${string}`;

/**
 * Whether `href` names a whole URL rather than a path. The client router only
 * handles paths on the current host; anything absolute is a full page load.
 */
export function isAbsoluteUrl(href: string): href is AbsoluteUrl {
  return /^https?:\/\//i.test(href);
}

/**
 * An absolute URL for `path` on another host of the same app. The protocol and
 * port come from `origin`, the one the caller is on, so the URL a page on
 * `acme.localhost:5173` builds for `admin` stays on port 5173 in development
 * and on none behind a production proxy.
 */
export function domainUrl(
  base: { root: string; origin: string },
  target: DomainTarget,
  path = "/",
): AbsoluteUrl {
  const current = new URL(base.origin);
  const hostname = target.host
    ? target.host
    : target.subdomain
      ? `${target.subdomain}.${base.root}`
      : base.root;
  const url = new URL(path.startsWith("/") ? path : `/${path}`, current);
  url.hostname = hostname;
  return url.toString() as AbsoluteUrl;
}
