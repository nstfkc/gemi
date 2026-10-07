import type { JSX } from "react";
import type { HttpRequest } from "../../http/HttpRequest";
import type { ApiRouter } from "../../http/ApiRouter";
import type { McpRouter } from "../../http/McpRouter";
import type { McpRemoteFileOptions } from "../mcp/McpRegistry";
import type { McpRemoteHttpConfig } from "../mcp/http/McpHttpServer";
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

/** See `ViewRouteConfig.localeRouting`. */
export type LocaleRouting = "prefix" | "off";

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

  /**
   * How these views take part in locale routing when `translation`
   * configures `supportedLocales`. Set it on a `route.domains` group's `view`
   * to opt that host out (e.g. user-published sites that are not the app's
   * own UI), or with the `"no-locale"` middleware directive on one router or
   * route.
   *
   * - `"prefix"` (default): URLs carry the locale (`/tr-TR/about`), and a
   *   visitor whose cookie or `Accept-Language` names another locale is
   *   redirected to it.
   * - `"off"`: URLs never carry a locale and nothing redirects. A first
   *   segment like `/tr-TR` is an ordinary path. Nothing is detected from the
   *   cookie or `Accept-Language`, and no `i18n-locale` cookie is set. The
   *   request renders in `translation.defaultLocale` unless middleware picks
   *   one with `Lang.setLocale(locale, { cookie: false })`.
   */
  localeRouting?: LocaleRouting;

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
  /** Remote MCP callers (#762). */
  remote?: McpRemoteConfig;
}

/**
 * The MCP endpoint remote clients connect to (#762). Off unless `enabled`.
 * See `McpRemoteHttpConfig`.
 */
export interface McpRemoteConfig extends McpRemoteHttpConfig {
  /**
   * How a remote caller's file arguments are read: the largest file, and
   * whether an `https` URL may be fetched instead of base64 bytes (off by
   * default). See `McpRemoteFileOptions`.
   */
  files?: McpRemoteFileOptions;
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

/**
 * `route.domains.trustProxy` in its long form: which header carries the host
 * the client addressed, and what proves the proxy sent it.
 */
export interface TrustProxyConfig {
  /**
   * The header the host is read from — the one the proxy in front writes the
   * client's host into. Defaults to `"x-forwarded-host"`.
   *
   * Name one the platform in front does not own. Behind a CDN that terminates
   * the customer's TLS and then a host like Railway, Render, Fly or Heroku,
   * the host overwrites `X-Forwarded-Host` with the `Host` it was reached by,
   * which the CDN had to rewrite to the app's own domain; the customer's host
   * only survives in a header the CDN adds, e.g. `X-Original-Host: ${http.host}`.
   */
  hostHeader?: string;

  /**
   * Trusts `hostHeader` only on a request that carries this header with this
   * value — a shared secret the proxy adds, so a client that reaches the app
   * directly, around the proxy, cannot name its own host. Without it the
   * request is routed by its own host, exactly as with `trustProxy` left out.
   *
   * `value` must be at least 16 characters and is compared in constant time.
   * The header is withheld from what a `proxy()` route forwards upstream.
   */
  secret?: { header: string; value: string };
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
   * Read the host from a header the proxy in front sets, rather than the
   * request URL. Only set it behind a proxy that overwrites that header, or a
   * client picks its own host.
   *
   * `true` reads `X-Forwarded-Host`. An object names the header, and can make
   * trusting it depend on a shared secret the proxy sends — see
   * {@link TrustProxyConfig}.
   *
   * The scheme is read from `X-Forwarded-Proto` whether or not this is set.
   */
  trustProxy?: boolean | TrustProxyConfig;

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
    localeRouting: "prefix",
    onRequestStart: () => {},
    onRequestEnd: () => {},
    onRequestFail: () => {},
    onStreamComplete: () => {},
  };
}
