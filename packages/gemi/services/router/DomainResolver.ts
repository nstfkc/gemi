import type { CustomDomainConfig, DomainGroupConfig, DomainsConfig } from "./config";

/** The group key the apex itself is served under. */
export const ROOT_GROUP = "";
/** The group key of `custom.fallback`. */
export const FALLBACK_GROUP = "*";

/** Which host group a request landed in, and what its host said. */
export interface ResolvedDomain {
  /** The request's hostname, lowercased and without the port. */
  host: string;
  /** `""` for the apex, the group's `subdomain` otherwise, `"*"` for the fallback. */
  group: string;
  /** A param subdomain's value, or what `custom.resolve` returned. */
  params: Record<string, string>;
  /** Whether the host is outside `domains.root`, i.e. a custom domain. */
  custom: boolean;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MIN_ASK_SECRET_LENGTH = 16;

function isParamSubdomain(subdomain: string) {
  return subdomain.startsWith(":");
}

/** Lowercased hostname without port or trailing dot; `null` if unparseable. */
export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) {
    return null;
  }
  try {
    return new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** The same, keeping the port — for rebuilding an origin. `null` if unparseable. */
function hostAndPort(host: string): string | null {
  try {
    const url = new URL(`http://${host.trim()}`);
    // `url.host` keeps userinfo out; the hostname is re-read to drop a trailing
    // dot the way `normalizeHost` does.
    const name = url.hostname.toLowerCase().replace(/\.$/, "");
    return name ? (url.port ? `${name}:${url.port}` : name) : null;
  } catch {
    return null;
  }
}

/**
 * Fails the boot on a `domains` config that could never route the way it
 * reads: an empty root, a subdomain declared twice, a malformed label, two
 * param groups competing for the same label, or a custom-domain target that
 * names no group.
 */
export function assertValidDomainsConfig(config: DomainsConfig) {
  const root = normalizeHost(config.root);
  // `normalizeHost` alone accepts far more than a hostname, and every one of
  // these booted cleanly and then matched no request at all:
  // `https://example.com` parses down to the host `https` — a valid label, so
  // checking the labels is not enough — while `.example.com` keeps its empty
  // first label, and `example.com:8080` quietly loses the port it was given.
  // So the labels have to be valid *and* nothing may have been dropped.
  const asGiven = config.root?.trim().toLowerCase().replace(/\.$/, "");
  if (!root || root !== asGiven || !root.split(".").every((label) => LABEL.test(label))) {
    throw new Error(
      `\`route.domains.root\` must be a bare hostname, e.g. "example.com" — no scheme, port or path. Got "${config.root}".`,
    );
  }
  if (config.custom && (config.custom.cacheTtlMs ?? 0) < 0) {
    throw new Error(
      `\`route.domains.custom.cacheTtlMs\` is ${config.custom.cacheTtlMs}; it cannot be negative. Use 0 to disable the cache.`,
    );
  }
  if (config.ask && config.ask.secret.length < MIN_ASK_SECRET_LENGTH) {
    throw new Error(
      `\`route.domains.ask.secret\` must be at least ${MIN_ASK_SECRET_LENGTH} characters. A guessable one is worse than leaving \`ask\` out.`,
    );
  }
  const seen = new Set<string>();
  let paramGroup: DomainGroupConfig | null = null;
  for (const group of config.groups ?? []) {
    const { subdomain } = group;
    if (seen.has(subdomain)) {
      throw new Error(`\`route.domains\` declares the subdomain "${subdomain}" twice.`);
    }
    seen.add(subdomain);
    if (isParamSubdomain(subdomain)) {
      if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(subdomain)) {
        throw new Error(
          `"${subdomain}" is not a valid param subdomain. It must be a single \`:name\` label.`,
        );
      }
      if (paramGroup) {
        throw new Error(
          `\`route.domains\` declares two param subdomains, "${paramGroup.subdomain}" and "${subdomain}"; a host could match either.`,
        );
      }
      paramGroup = group;
      continue;
    }
    if (group.exists) {
      throw new Error(
        `The subdomain "${subdomain}" is fixed, so \`exists\` has no param to check. It only applies to a \`:param\` subdomain.`,
      );
    }
    if (!subdomain.split(".").every((label) => LABEL.test(label))) {
      throw new Error(`"${subdomain}" is not a valid subdomain.`);
    }
  }
  if (config.custom && !seen.has(config.custom.group)) {
    throw new Error(
      `\`route.domains.custom.group\` is "${config.custom.group}", but no group declares that subdomain.`,
    );
  }
  // Without `exists` the param group matches every label, so the ask endpoint
  // would approve a certificate for every name anyone connects with, and a
  // scripted walk would spend the certificate authority's rate limit for the
  // whole registered domain — after which no real tenant can get one either.
  if (config.ask && paramGroup && !paramGroup.exists) {
    throw new Error(
      `\`route.domains.ask\` is set, so "${paramGroup.subdomain}" needs an \`exists\` to say which tenants are real. Without one every host under the root would be approved for a certificate.`,
    );
  }
}

/**
 * Maps a request's host onto one of the `route.domains` groups. Pure apart from
 * the calls into `exists` and `custom.resolve`, and the cache in front of the
 * latter.
 */
export class DomainResolver {
  readonly root: string;
  private readonly trustProxy: boolean;
  private readonly fixed = new Map<string, DomainGroupConfig>();
  private readonly param: (DomainGroupConfig & { name: string }) | null = null;
  private readonly custom: CustomDomainConfig | null;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<
    string,
    { value: Record<string, string> | null; expiresAt: number }
  >();
  /** In-progress `custom.resolve` calls, so concurrent misses share one. */
  private readonly inFlight = new Map<string, Promise<Record<string, string> | null>>();
  /** The `ask` secret, or `null` when the endpoint is not served. */
  readonly askSecret: string | null;

  constructor(config: DomainsConfig) {
    assertValidDomainsConfig(config);
    this.root = normalizeHost(config.root)!;
    this.trustProxy = config.trustProxy ?? false;
    for (const group of config.groups ?? []) {
      if (isParamSubdomain(group.subdomain)) {
        this.param = { ...group, name: group.subdomain.slice(1) };
      } else {
        this.fixed.set(group.subdomain.toLowerCase(), group);
      }
    }
    this.custom = config.custom ?? null;
    this.cacheTtlMs = this.custom?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.askSecret = config.ask?.secret ?? null;
  }

  /** The hostname the request is addressed to, honouring `trustProxy`. */
  hostOf(req: Request): string | null {
    if (this.trustProxy) {
      const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0];
      const host = normalizeHost(forwarded);
      if (host) {
        return host;
      }
    }
    return normalizeHost(new URL(req.url).host);
  }

  /**
   * The origin the client addressed, port included — behind a trusted proxy,
   * the forwarded one rather than the one the proxy reached the app on.
   *
   * The scheme follows `X-Forwarded-Proto` whether or not `trustProxy` is set,
   * and the host only when it is. They are gated differently because the
   * hazards are: a forged host sends a link to somewhere the attacker chose,
   * while a forged scheme only spoils the attacker's own links. TLS is almost
   * always terminated by a proxy that reaches the app over plain http, so
   * reading the scheme is what keeps a cross-host URL from coming out `http://`
   * on an `https://` page.
   */
  publicOrigin(req: Request): string {
    const url = new URL(req.url);
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    // An allowlist, not the header's text: it is spliced into an origin, and
    // `javascript` there would build a URL that is typed absolute but that
    // nothing treats as one.
    const proto =
      forwardedProto === "http" || forwardedProto === "https"
        ? forwardedProto
        : url.protocol.replace(/:$/, "");
    if (!this.trustProxy) {
      return `${proto}://${url.host}`;
    }
    // Through `normalizeHost` so userinfo, whitespace and an unparseable header
    // cannot ride into the origin — and back through `URL` so the port
    // survives, which `normalizeHost` drops.
    const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost && normalizeHost(forwardedHost) ? hostAndPort(forwardedHost) : null;
    return `${proto}://${host ?? url.host}`;
  }

  /** The group serving `req`, or `null` when no group, and no fallback, serves its host. */
  async resolve(req: Request): Promise<ResolvedDomain | null> {
    const host = this.hostOf(req);
    if (!host) {
      return null;
    }
    const match = await this.match(host, req);
    if (match) {
      return match;
    }
    if (this.custom?.fallback && !this.isUnderRoot(host)) {
      return { host, group: FALLBACK_GROUP, params: {}, custom: true };
    }
    return null;
  }

  /**
   * Whether `host` is one the app serves in its own right — what a TLS proxy
   * asks before issuing a certificate. The fallback group does not count: it
   * would otherwise approve every host on the internet.
   */
  async allows(host: string, req: Request): Promise<boolean> {
    const normalized = normalizeHost(host);
    return normalized ? (await this.match(normalized, req)) !== null : false;
  }

  private isUnderRoot(host: string) {
    return host === this.root || host.endsWith(`.${this.root}`);
  }

  private async match(host: string, req: Request): Promise<ResolvedDomain | null> {
    if (host === this.root) {
      return { host, group: ROOT_GROUP, params: {}, custom: false };
    }
    if (host.endsWith(`.${this.root}`)) {
      const sub = host.slice(0, -(this.root.length + 1));
      const fixed = this.fixed.get(sub);
      if (fixed) {
        return { host, group: fixed.subdomain, params: {}, custom: false };
      }
      if (this.param && LABEL.test(sub)) {
        const params = { [this.param.name]: sub };
        if (this.param.exists && !(await this.param.exists(params, req))) {
          return null;
        }
        return { host, group: this.param.subdomain, params, custom: false };
      }
      return null;
    }
    if (!this.custom) {
      return null;
    }
    const params = await this.resolveCustom(host);
    return params ? { host, group: this.custom.group, params, custom: true } : null;
  }

  private async resolveCustom(host: string) {
    const now = Date.now();
    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > now) {
      // Re-insert to move it to the end: a Map iterates in insertion order, so
      // this is what makes the eviction below least-recently-*used* rather than
      // oldest-inserted. Without it a burst of unknown hosts evicts every real
      // customer, however often they are asked for.
      this.cache.delete(host);
      this.cache.set(host, cached);
      return cached.value;
    }
    // One call per host at a time. A cold host that a hundred requests arrive
    // for at once is one `resolve`, not a hundred — the difference between a
    // cache miss and a stampede against the database behind it.
    const inFlight = this.inFlight.get(host);
    if (inFlight) {
      return inFlight;
    }
    const pending = (async () => (await this.custom!.resolve(host)) ?? null)();
    this.inFlight.set(host, pending);
    let value: Record<string, string> | null;
    try {
      value = await pending;
    } finally {
      // Before the `set` below, so a throw leaves nothing cached and nothing
      // stuck: the next request retries.
      this.inFlight.delete(host);
    }
    if (this.cacheTtlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.delete(host);
      this.cache.set(host, { value, expiresAt: Date.now() + this.cacheTtlMs });
    }
    return value;
  }

  /** Drops cached `custom.resolve` answers — one host, or all of them. */
  forget(host?: string) {
    if (host === undefined) {
      this.cache.clear();
    } else {
      const normalized = normalizeHost(host);
      if (normalized) {
        this.cache.delete(normalized);
      }
    }
  }
}
