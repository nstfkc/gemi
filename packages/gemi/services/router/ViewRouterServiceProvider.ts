import type { JSX } from "react";
import type { HttpRequest } from "../../http";
import type { ViewRouter } from "../../http/ViewRouter";
import { ServiceProvider } from "../ServiceProvider";
import type { StreamSummary } from "./ServerQueryStore";

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

  /**
   * Fires when the response body actually closes — after the last streamed
   * chunk, not when the handler returns. Under streaming those are very
   * different moments: the handler returns at time-to-shell while queries
   * keep streaming for as long as the slowest one takes, so an APM span
   * ended in the handler under-reports every streamed request. End it here
   * instead; `summary` carries `shellAt`/`settledAt`, whether the stream
   * deadline aborted rendering, and per-query timings. Non-streamed
   * responses (`.json` payloads, `no-stream` routes, bot requests) report
   * `shellAt === settledAt`.
   *
   * Although the body closes long after the handler returned, the router
   * re-enters the request's scopes around this hook — facades and
   * `req.ctx()` work here exactly as they do in the other lifecycle hooks.
   */
  onStreamComplete(
    _req: HttpRequest,
    _summary: StreamSummary,
  ): void | Promise<void> {}
}
