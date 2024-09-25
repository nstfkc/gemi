import type { WebSocketHandler } from "bun";
import { Kernel } from "../kernel";
import { KernelContext } from "../kernel/KernelContext";

interface AppParams {
  kernel: new () => Kernel;
}

export class App {
  public name = "APP";
  public devVersion = 0;
  private kernel: Kernel;

  constructor(params: AppParams) {
    this.kernel = new params.kernel();
  }

  public getComponentTree() {
    return this.kernel.getServices().viewRouterServiceContainer.componentTree;
  }

  public getFlatComponentTree() {
    return this.kernel.getServices().viewRouterServiceContainer
      .flatComponentTree;
  }

  public async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    return this.kernel.run.call(this.kernel, async () => {
      if (url.pathname.startsWith("/api")) {
        return await this.kernel.services.apiRouterServiceContainer.handleApiRequest(
          req,
        );
      } else {
        return await this.kernel.services.viewRouterServiceContainer.handleViewRequest(
          req,
        );
      }
    });
  }

  public websocket: WebSocketHandler<{ headers: Headers }> = {
    message: (ws, message) => {
      const kernelRun = this.kernel.run.bind(this.kernel);
      kernelRun(() => {
        KernelContext.getStore().broadcastingServiceContainer.run(
          ws.data.headers,
          () => {
            KernelContext.getStore().broadcastingServiceContainer.handleMessage(
              ws,
              message,
            );
          },
        );
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
    // this.kernel.services.broadcastingServiceContainer.onPublish(fn);
  }
}
