import type { JSX } from "react";
import type { HttpRequest } from "../../http/HttpRequest";
import type { ApiRouter } from "../../http/ApiRouter";
import type { ViewRouter } from "../../http/ViewRouter";

// Config key: `route.api`. Derived from `ApiRouterServiceProvider`.
export interface ApiRouteConfig {
  rootRouter: new () => ApiRouter;

  onRequestStart?: (req: HttpRequest) => void | Promise<void>;
  onRequestEnd?: (req: HttpRequest) => void | Promise<void>;
  onRequestFail?: (req: HttpRequest, error: any) => void | Promise<void>;
}

// Config key: `route.view`. Derived from `ViewRouterServiceProvider`.
export interface ViewRouteConfig {
  root: (props: any) => JSX.Element;
  rootRouter: new () => ViewRouter;

  onRequestStart?: (req: HttpRequest) => void | Promise<void>;
  onRequestEnd?: (req: HttpRequest) => void | Promise<void>;
  onRequestFail?: (req: HttpRequest, error: any) => void | Promise<void>;
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
    onRequestStart: () => {},
    onRequestEnd: () => {},
    onRequestFail: () => {},
  };
}
