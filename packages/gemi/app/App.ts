import type { WebSocketHandler } from "bun";
import type { Kernel } from "../kernel";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { ViewRouterServiceContainer } from "../services/router/ViewRouterServiceContainer";
import { BroadcastingServiceContainer } from "../services/pubsub/BroadcastingServiceContainer";
import { QueueServiceContainer } from "../services/queue/QueueServiceContainer";

interface AppParams {
  kernel: new () => Kernel;
}

export class App {
  private kernel: Kernel;

  constructor(params: AppParams) {
    this.kernel = new params.kernel();
    this.kernel.boot.call(this.kernel);
  }

  public getComponentTree() {
    return this.kernel.run.call(this.kernel, () => {
      return ViewRouterServiceContainer.use().componentTree;
    });
  }

  public getFlatComponentTree() {
    return this.kernel.run.call(this.kernel, () => {
      return ViewRouterServiceContainer.use().flatComponentTree;
    });
  }

  public getRouteManifest() {
    return this.kernel.run.call(this.kernel, () => {
      return ViewRouterServiceContainer.use().routeManifest;
    });
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
