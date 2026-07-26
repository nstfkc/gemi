import type { WebSocketHandler } from "bun";
import type { Kernel } from "../kernel";

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

  public async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return this.kernel.run.call(this.kernel, async () => {
      if (url.pathname.startsWith("/api")) {
        return await this.kernel.apiRoutes().handleApiRequest(req);
      }
      return await this.kernel.viewRoutes().handleViewRequest(req);
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

  public destroy() {
    this.kernel.destroy();
  }

  public clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  }
}

export type FetchHandler = InstanceType<typeof App>["fetch"];
