import { timingSafeEqual } from "node:crypto";
import { ApiRouteDispatcher } from "./ApiRouteDispatcher";
import { ViewRouteDispatcher } from "./ViewRouteDispatcher";
import { DomainResolver, FALLBACK_GROUP, ROOT_GROUP, type ResolvedDomain } from "./DomainResolver";
import type { ApiRouteConfig, DomainGroupRouters, DomainsConfig, ViewRouteConfig } from "./config";
import { setRequestDomain } from "../../http/requestDomain";

/**
 * Where a TLS proxy asks whether to issue a certificate for a host — Caddy's
 * `on_demand_tls { ask ... }`. Answered before host resolution, since the
 * proxy calls it on whatever host it reaches the app by.
 */
export const DOMAIN_ASK_PATH = "/__gemi__/domains/ask";

/**
 * Compares in constant time, so the secret cannot be recovered a character at
 * a time. The length is compared first and leaks, which `timingSafeEqual`
 * requires and which tells an attacker nothing they can walk.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (given === null) {
    return false;
  }
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DomainDispatchers {
  api: ApiRouteDispatcher;
  view: ViewRouteDispatcher;
}

/**
 * One api/view dispatcher pair per `route.domains` group. A group that brings
 * no routers of its own shares the root's dispatcher for that side — the same
 * instance, not a copy — so a tenant subdomain running the root app costs
 * nothing extra and keeps the root's typed routes.
 */
export class DomainRouter {
  static token = "router.domains";

  /** `null` when the app declares no `route.domains`: every host is the root. */
  readonly resolver: DomainResolver | null;
  /** Whether hosts outside the root are served at all — `route.domains.custom` is set. */
  readonly acceptsCustomDomains: boolean;
  private readonly groups = new Map<string, DomainDispatchers>();

  constructor(
    root: DomainDispatchers,
    config: { api: ApiRouteConfig; view: ViewRouteConfig; domains?: DomainsConfig },
  ) {
    this.groups.set(ROOT_GROUP, root);
    const { domains } = config;
    this.acceptsCustomDomains = Boolean(domains?.custom);
    if (!domains) {
      this.resolver = null;
      return;
    }
    this.resolver = new DomainResolver(domains);

    const build = (routers: DomainGroupRouters): DomainDispatchers => ({
      api: routers.api ? new ApiRouteDispatcher({ ...config.api, ...routers.api }) : root.api,
      view: routers.view ? new ViewRouteDispatcher({ ...config.view, ...routers.view }) : root.view,
    });
    for (const group of domains.groups ?? []) {
      this.groups.set(group.subdomain, build(group));
    }
    if (domains.custom?.fallback) {
      this.groups.set(FALLBACK_GROUP, build(domains.custom.fallback));
    }
  }

  /**
   * Resolves `req`'s host group, records it for every `HttpRequest` built over
   * `req`, and returns that group's dispatchers — `null` when no group serves
   * the host. Lives here, not in `App.fetch`, because the request's domain
   * must be recorded by the app's copy of gemi, which is the one the handlers
   * read it back from (see the note at the top of `app/App.ts`).
   */
  async route(req: Request): Promise<DomainDispatchers | null> {
    if (!this.resolver) {
      return this.dispatchers(null);
    }
    const domain = await this.resolver.resolve(req);
    if (!domain) {
      return null;
    }
    setRequestDomain(req, domain);
    return this.dispatchers(domain);
  }

  /**
   * Answers a TLS proxy's on-demand "ask": 200 when `?domain=` names a host
   * the app serves in its own right, 404 otherwise. `null` when `req` is not
   * an ask, the app declares no `route.domains`, or `route.domains.ask` is
   * not configured or its secret does not match.
   *
   * Falling through on a bad secret rather than answering 401 is deliberate:
   * the reply to a wrong guess is then whatever the app answers for any
   * unrouted path, so the endpoint cannot be found by probing for it. The
   * answer it gives is "is this host a tenant of yours", which is worth
   * guarding — and each one costs the app an `exists` or `resolve` call.
   */
  async ask(req: Request): Promise<Response | null> {
    if (!this.resolver?.askSecret || req.method !== "GET") {
      return null;
    }
    const url = new URL(req.url);
    if (url.pathname !== DOMAIN_ASK_PATH) {
      return null;
    }
    if (!secretMatches(url.searchParams.get("secret"), this.resolver.askSecret)) {
      return null;
    }
    const host = url.searchParams.get("domain");
    const allowed = host ? await this.resolver.allows(host, req) : false;
    return new Response(null, { status: allowed ? 200 : 404 });
  }

  /** The dispatchers of `domain`'s group; the root's for `null`. */
  dispatchers(domain: ResolvedDomain | null): DomainDispatchers {
    return this.groups.get(domain?.group ?? ROOT_GROUP)!;
  }

  /** Every distinct view dispatcher, the root's first — for anything that has to know every view. */
  viewDispatchers(): ViewRouteDispatcher[] {
    return Array.from(new Set(Array.from(this.groups.values(), (group) => group.view)));
  }
}
