// Type-only: `services/router` imports from `http`, so a runtime import here
// would be circular.
import type { ResolvedDomain } from "../services/router/DomainResolver";

// Keyed by the raw Request, so the domain `App.fetch` resolved reaches the
// dispatcher, and every `HttpRequest` built over that Request, without a
// second AsyncLocalStorage that a streaming render would step outside of.
const domains = new WeakMap<Request, ResolvedDomain>();

export function setRequestDomain(req: Request, domain: ResolvedDomain) {
  domains.set(req, domain);
}

/** The host group `req` was routed by, or `null` when `route.domains` is not configured. */
export function requestDomain(req: Request): ResolvedDomain | null {
  return domains.get(req) ?? null;
}

// Headers meant for this app alone — `route.domains.trustProxy.secret` — that
// a `proxy()` route must not forward upstream with the rest of the client's.
const withheld = new WeakMap<Request, string[]>();

export function withholdFromUpstream(req: Request, header: string) {
  const headers = withheld.get(req) ?? [];
  if (!headers.includes(header)) {
    withheld.set(req, [...headers, header]);
  }
}

/** The lowercased header names a `proxy()` route drops from `req` before forwarding it. */
export function withheldFromUpstream(req: Request): readonly string[] {
  return withheld.get(req) ?? [];
}
