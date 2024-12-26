import React from "react";
import { HttpRequest } from "../../http";
import type { ViewRouter } from "../../http/ViewRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ViewRouterServiceProvider extends ServiceProvider {
  root: (props: any) => React.JSX.Element;
  rootRouter: new () => ViewRouter;

  boot() {}

  onRequestStart(_req: HttpRequest): void | Promise<void> {}
  onRequestEnd(_req: HttpRequest): void | Promise<void> {}
  onRequestFail(_req: HttpRequest, _error: any): void | Promise<void> {}
}
