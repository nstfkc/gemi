import type { JSX } from "react";
import type { HttpRequest } from "../../http";
import type { ViewRouter } from "../../http/ViewRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ViewRouterServiceProvider extends ServiceProvider {
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
  partialRendering = true;

  boot() {}

  onRequestStart(_req: HttpRequest): void | Promise<void> {}
  onRequestEnd(_req: HttpRequest): void | Promise<void> {}
  onRequestFail(_req: HttpRequest, _error: any): void | Promise<void> {}
}
