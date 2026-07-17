import type { WebSocketHandler } from "bun";
import type { Kernel } from "../kernel";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { ViewRouterServiceContainer } from "../services/router/ViewRouterServiceContainer";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { QueueServiceContainer } from "../services/queue/QueueServiceContainer";

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

  // Read-only tooling accessors used at build time (createRollupInput, the
  // `app:*` bin commands). These deliberately read the container straight from
  // `kernel.services` instead of going through `ViewRouterServiceContainer.use()`.
  // The built bin (`dist/bin/gemi.js`) bundles its own copy of gemi, while the
  // app's Kernel resolves `gemi/*` to the source modules — so the two have
  // *different* `kernelContext` AsyncLocalStorage instances and `.use()` reads
  // an empty store. Looking the container up by its string `_name` is identical
  // across both copies and needs no ambient context.
  private useViewRouter(): ViewRouterServiceContainer {
    const container = this.kernel.services[ViewRouterServiceContainer._name] as
      | ViewRouterServiceContainer
      | undefined;
    if (!container) {
      throw new Error(
        "ViewRouterServiceContainer is not registered — was the kernel booted?",
      );
    }
    return container;
  }

  public getComponentTree() {
    return this.useViewRouter().componentTree;
  }

  public getFlatComponentTree() {
    return this.useViewRouter().flatComponentTree;
  }

  public getRouteManifest() {
    return this.useViewRouter().routeManifest;
  }

  public async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return this.kernel.run.call(this.kernel, async () => {
      if (url.pathname.startsWith("/api")) {
        return await ApiRouterServiceContainer.use().handleApiRequest(req);
      }
      return await ViewRouterServiceContainer.use().handleViewRequest(req);
    });
  }

  public websocket: WebSocketHandler<{ headers: Headers }> = {
    message: (ws, message) => {
      const kernelRun = this.kernel.run.bind(this.kernel);
      kernelRun(() => {
        BroadcastingServiceContainer.use().run(ws.data.headers, () => {
          BroadcastingServiceContainer.use().handleMessage(ws, message);
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
      BroadcastingServiceContainer.use().onPublish(fn);
    });
  }

  public dispatchJob(jobName: string, args: string) {
    const kernelRun = this.kernel.run.bind(this.kernel);
    return kernelRun(() => {
      return QueueServiceContainer.use().dispatchJob(jobName, args);
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
