import type { WebSocketHandler } from "bun";
import type { Kernel } from "../kernel";
import { isApiPath } from "../services/router/apiPath";

interface AppParams {
  kernel: new () => Kernel;
  onException?: (error: Error) => void;
}

export class App {
  private kernel: Kernel;
  public onException?: (error: Error) => void;

  constructor(params: AppParams) {
    this.kernel = new params.kernel();
    this.kernel.boot.call(this.kernel);
    this.onException =
      params.onException ??
      ((error: Error) => {
        console.error("Unhandled exception in App:", error);
      });
  }

  // Every service this class touches is resolved through a `this.kernel.*`
  // accessor rather than by importing the service class and calling `app()`
  // here. That is deliberate: the built bin (`dist/bin/gemi.js`) bundles its own
  // copy of gemi, while the app's Kernel is loaded from source and resolves
  // `gemi/*` to the source modules — so the two copies have *different*
  // `kernelContext` AsyncLocalStorage instances and different `Application`
  // class objects. A method call on the Kernel executes in the app's copy and
  // reads the app's container; a resolution attempted here would not. Service
  // *tokens* still cross the boundary safely (they are plain strings), which is
  // why `kernel.resolve()` works from either side.
  public async waitForBoot() {
    await this.kernel.waitForBoot();
  }

  public getComponentTree() {
    return this.kernel.viewRoutes().componentTree;
  }

  public getFlatComponentTree() {
    return this.kernel.viewRoutes().flatComponentTree;
  }

  public getRouteManifest() {
    return this.kernel.viewRoutes().routeManifest;
  }

  // Requests `withGlobalMiddleware` already ran the global middleware for, so
  // `fetch` inside it does not run the list a second time. Keyed by the Request
  // object: the servers hand `fetch` the same one they gated.
  private globallyGated = new WeakSet<Request>();

  /**
   * Runs the `global` middleware list, then `next` — what the servers put in
   * front of everything they serve, so the list covers static files, which
   * never reach `fetch`, as well as routes. A refusal is answered without
   * calling `next`. A global middleware that throws something other than a
   * break is answered by `onError` rather than by `next`, since a gate that
   * failed must not let a static file through.
   */
  public async withGlobalMiddleware(
    req: Request,
    next: (req: Request) => Promise<Response>,
    onError: (err: unknown) => Response | Promise<Response>,
  ): Promise<Response> {
    let outcome: Awaited<ReturnType<Kernel["globalMiddleware"]>>;
    try {
      outcome = await this.kernel.run.call(this.kernel, () => this.kernel.globalMiddleware(req));
    } catch (err) {
      return await onError(err);
    }
    if (outcome.refusal) {
      return outcome.refusal;
    }
    this.globallyGated.add(req);
    return outcome.apply(await next(req));
  }

  public async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return this.kernel.run.call(this.kernel, async () => {
      // Run here too for a caller that is not one of the servers, a test or an
      // app's own `Bun.serve`, so the list is not skipped by calling `fetch`.
      const outcome = this.globallyGated.has(req) ? null : await this.kernel.globalMiddleware(req);
      if (outcome?.refusal) {
        return outcome.refusal;
      }
      const result = isApiPath(url.pathname)
        ? await this.kernel.apiRoutes().handleApiRequest(req)
        : await this.kernel.viewRoutes().handleViewRequest(req);
      if (!outcome) {
        return result;
      }
      // A document comes back as a render function the server calls with its
      // manifests, and the Response only exists once it has.
      if (typeof result === "function") {
        const render = result as (...args: any[]) => Promise<Response>;
        return (async (...args: any[]) => outcome.apply(await render(...args))) as any;
      }
      return outcome.apply(result);
    });
  }

  public websocket: WebSocketHandler<{ headers: Headers }> = {
    message: (ws, message) => {
      const kernelRun = this.kernel.run.bind(this.kernel);
      kernelRun(() => {
        const broadcast = this.kernel.broadcast();
        broadcast.run(ws.data.headers, () => {
          broadcast.handleMessage(ws, message);
        });
      });
    },
    open: (_ws) => {},
    close: (ws) => {
      console.log("closed ws");
      ws.terminate();
    },
  };

  public onPublish(
    fn: (
      topic: string,
      data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer,
      compress?: boolean,
    ) => void,
  ) {
    const kernelRun = this.kernel.run.bind(this.kernel);
    kernelRun(() => {
      this.kernel.broadcast().onPublish(fn);
    });
  }

  public dispatchJob(jobName: string, args: string) {
    const kernelRun = this.kernel.run.bind(this.kernel);
    return kernelRun(() => {
      return this.kernel.queue().dispatchJob(jobName, args);
    });
  }

  /** Every provider's `shutdown()`; see `Kernel.shutdown`. */
  public shutdown(options?: { timeoutMs?: number }) {
    return this.kernel.shutdown(options);
  }

  public destroy() {
    this.kernel.destroy();
  }

  public clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  }
}

export type FetchHandler = InstanceType<typeof App>["fetch"];
