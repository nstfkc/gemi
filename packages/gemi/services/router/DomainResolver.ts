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

/**
 * Fails the boot on a `domains` config that could never route the way it
 * reads: an empty root, a subdomain declared twice, a malformed label, two
 * param groups competing for the same label, or a custom-domain target that
 * names no group.
 */
export function assertValidDomainsConfig(config: DomainsConfig) {
  const root = normalizeHost(config.root);
  if (!root) {
    throw new Error('`route.domains.root` must be a hostname, e.g. "example.com".');
  }
  const seen = new Set<string>();
  let paramGroup: string | null = null;
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
          `\`route.domains\` declares two param subdomains, "${paramGroup}" and "${subdomain}"; a host could match either.`,
        );
      }
      paramGroup = subdomain;
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
   */
  publicOrigin(req: Request): string {
    const url = new URL(req.url);
    if (!this.trustProxy) {
      return url.origin;
    }
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    return `${proto || url.protocol.replace(/:$/, "")}://${host || url.host}`;
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
      return cached.value;
    }
    const value = (await this.custom!.resolve(host)) ?? null;
    if (this.cacheTtlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        // Oldest insertion first — a Map iterates in insertion order.
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.delete(host);
      this.cache.set(host, { value, expiresAt: now + this.cacheTtlMs });
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
