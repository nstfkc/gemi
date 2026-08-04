import type { JSX } from "react";
import type { HttpRequest } from "../../http/HttpRequest";
import type { ApiRouter } from "../../http/ApiRouter";
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

// Config key: `route`. Covers both route dispatchers.
export interface RouteConfig {
  api: ApiRouteConfig;
  view: ViewRouteConfig;
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
