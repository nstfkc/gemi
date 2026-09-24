import type { JSX } from "react";
import type { HttpRequest } from "../../http/HttpRequest";
import type { ApiRouter } from "../../http/ApiRouter";
import type { McpRouter } from "../../http/McpRouter";
import type { ViewRouter } from "../../http/ViewRouter";
import type { StreamSummary } from "./ServerQueryStore";

// Config key: `route.api`. Derived from `ApiRouterServiceProvider`.
export interface ApiRouteConfig {
  // `typeof ApiRouter`, not `new () => ApiRouter`: route flattening identifies
  // nested routers by the static `__brand`, which a bare construct signature
  // does not carry.
  rootRouter: typeof ApiRouter;

  onRequestStart?: (req: HttpRequest) => void | Promise<void>;
  onRequestEnd?: (req: HttpRequest) => void | Promise<void>;
  onRequestFail?: (req: HttpRequest, error: any) => void | Promise<void>;
}

// Config key: `route.view`. Derived from `ViewRouterServiceProvider`.
export interface ViewRouteConfig {
  root: (props: any) => JSX.Element;
  rootRouter: new () => ViewRouter;

  /**
   * Whether a client-side navigation may skip the handlers of the layout
   * segments the client already has mounted, rather than re-running the whole
   * chain for every route below a layout.
   *
   * Set to `false` to run every handler on every navigation. Prefer
   * `alwaysRun()` on the one layout that needs it — this switch is for when an
   * app cannot audit them all at once.
   */
  partialRendering?: boolean;

  onRequestStart?: (req: HttpRequest) => void | Promise<void>;
  onRequestEnd?: (req: HttpRequest) => void | Promise<void>;
  onRequestFail?: (req: HttpRequest, error: any) => void | Promise<void>;

  /**
   * Fires when the response body actually closes — after the last streamed
   * chunk, not when the handler returns. Under streaming those are very
   * different moments: the handler returns at time-to-shell while queries keep
   * streaming for as long as the slowest one takes, so an APM span ended in the
   * handler under-reports every streamed request. End it here instead;
   * `summary` carries `shellAt`/`settledAt`, whether the stream deadline
   * aborted rendering, and per-query timings. Non-streamed responses (`.json`
   * payloads, `no-stream` routes, bot requests) report `shellAt === settledAt`.
   *
   * Although the body closes long after the handler returned, the dispatcher
   * re-enters the request's scopes around this hook — facades and `req.ctx()`
   * work here exactly as they do in the other lifecycle hooks.
   */
  onStreamComplete?: (
    req: HttpRequest,
    summary: StreamSummary,
  ) => void | Promise<void>;
}

// Config key: `route.mcp`. Optional: an app that exposes nothing to a model
// declares nothing.
export interface McpRouteConfig {
  // The app's `McpRouter`, normally `app/http/routes/mcp.ts`. Resolved against
  // the api routes at boot, so a stale reference fails the boot.
  router: new () => McpRouter<any>;
}

// The routers one host group serves. Either may be left out, in which case the
// group serves the root `api` / `view` config for that side — the usual case
// for tenant subdomains, which run the same app with different data.
export interface DomainGroupRouters {
  api?: Partial<ApiRouteConfig> & Pick<ApiRouteConfig, "rootRouter">;
  view?: Partial<ViewRouteConfig> & Pick<ViewRouteConfig, "rootRouter">;
}

export interface DomainGroupConfig extends DomainGroupRouters {
  /**
   * The label(s) in front of `domains.root`. A fixed subdomain (`"admin"`,
   * `"eu.admin"`) matches exactly; a param subdomain (`":tenant"`) matches any
   * single label and hands it to the request as `req.domain.params.tenant`.
   * Fixed subdomains are tried before param ones.
   */
  subdomain: string;

  /**
   * For a param subdomain: whether the value names something that exists. A
   * `false` answers the request with a 404 before any route runs, and keeps the
   * ask endpoint from approving a certificate for it.
   *
   * `req` is the request being routed — except on the ask path, where it is
   * the proxy's own request and says nothing about the host being judged. Read
   * `params`, not `req`'s host, headers or cookies, or a certificate decision
   * and a routing decision can disagree.
   */
  exists?: (
    params: Record<string, string>,
    req: Request,
  ) => boolean | Promise<boolean>;
}

export interface CustomDomainConfig {
  /**
   * The `subdomain` of the group a resolved custom host is served as — so
   * `app.acme.com` runs exactly what `acme.example.com` does.
   */
  group: string;

  /**
   * Maps a host outside `domains.root` to the params of `group`, or `null`
   * when the host is not one the app knows. Usually a database lookup;
   * answers are cached for `cacheTtlMs`.
   */
  resolve: (
    host: string,
  ) => Record<string, string> | null | Promise<Record<string, string> | null>;

  /** How long a `resolve` answer, hit or miss, is reused. Defaults to 60s; `0` disables. */
  cacheTtlMs?: number;

  /**
   * Serves every host `resolve` returned `null` for, instead of a 404. The ask
   * endpoint never approves a host on the strength of this group alone.
   */
  fallback?: DomainGroupRouters;
}

// Config key: `route.domains`. Optional: without it every host is served by
// the root routers, exactly as before.
export interface DomainsConfig {
  /**
   * The apex the subdomains hang off, e.g. `"example.com"` — `"localhost"` in
   * development, where `acme.localhost` resolves to loopback. Compared against
   * the request's hostname, so the port does not matter.
   */
  root: string;

  /**
   * Read the host from `X-Forwarded-Host` rather than the request URL. Only
   * set it behind a proxy that overwrites the header, or a client picks its
   * own host.
   */
  trustProxy?: boolean;

  groups?: DomainGroupConfig[];

  custom?: CustomDomainConfig;

  /**
   * Turns on the on-demand TLS ask endpoint, which a proxy calls to decide
   * whether to issue a certificate for a host.
   *
   * Left out, the path is not served at all — it answers the same 404 as any
   * other unrouted path. That is the default because the answer is exactly
   * "is this a tenant of yours", asked without a session: open to the
   * internet it enumerates tenant slugs and customer domains, and runs an
   * uncached `exists` or `resolve` per probe.
   *
   * `secret` must be at least 16 characters and is compared in constant time.
   * The proxy passes it as `?secret=`; anything else falls through unanswered,
   * so the endpoint cannot be probed for.
   */
  ask?: { secret: string };
}

// Config key: `route`. Covers both route dispatchers and the MCP registry.
export interface RouteConfig {
  api: ApiRouteConfig;
  view: ViewRouteConfig;
  mcp?: McpRouteConfig;
  domains?: DomainsConfig;
}

export function defineRouteConfig(config: RouteConfig): RouteConfig {
  return config;
}

// `rootRouter` / `root` have no defaults — the app must supply them.
export function apiRouteConfigDefaults(): Omit<
  Required<ApiRouteConfig>,
  "rootRouter"
> {
  return {
    onRequestStart: () => {},
    onRequestEnd: () => {},
    onRequestFail: () => {},
  };
}

export function viewRouteConfigDefaults(): Omit<
  Required<ViewRouteConfig>,
  "root" | "rootRouter"
> {
  return {
    partialRendering: true,
    onRequestStart: () => {},
    onRequestEnd: () => {},
    onRequestFail: () => {},
    onStreamComplete: () => {},
  };
}
