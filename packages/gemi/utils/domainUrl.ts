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
  const wanted = target.host
    ? target.host
    : target.subdomain
      ? `${target.subdomain}.${base.root}`
      : base.root;
  const url = new URL(path.startsWith("/") ? path : `/${path}`, current);
  // `url.hostname = x` is a WHATWG setter, and it *ignores* a value it cannot
  // parse rather than failing. A stored custom domain that carries a port or a
  // scheme therefore used to return a link to the host the caller is already
  // on — a wrong-tenant link that looks right. Parse it first, and take a port
  // with it, since a custom domain in development often has one.
  const host = asHost(wanted);
  if (!host) {
    throw new Error(
      `"${wanted}" is not a hostname, so there is no URL for it. Give a bare host, optionally with a port — no scheme, path or credentials.`,
    );
  }
  url.hostname = host.hostname;
  if (host.port) {
    url.port = host.port;
  }
  return url.toString() as AbsoluteUrl;
}

/** `value` as a host and port, or `null` if it is anything more than that. */
function asHost(value: string): { hostname: string; port: string } | null {
  try {
    const url = new URL(`http://${value.trim()}`);
    // A scheme leaves a path behind, and credentials leave the host shorter
    // than what was given; either means this is not a hostname.
    return url.host === value.trim().toLowerCase() && url.pathname === "/"
      ? { hostname: url.hostname, port: url.port }
      : null;
  } catch {
    return null;
  }
}
