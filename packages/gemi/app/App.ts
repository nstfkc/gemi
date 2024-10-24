import type { WebSocketHandler } from "bun";
import { Kernel } from "../kernel";
import { ApiRouterServiceContainer } from "../services/router/ApiRouterServiceContainer";
import { ViewRouterServiceContainer } from "../services/router/ViewRouterServiceContainer";

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

  public async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    return this.kernel.run.call(this.kernel, async () => {
      if (url.pathname.startsWith("/api")) {
        return await ApiRouterServiceContainer.use().handleApiRequest(req);
      } else {
        return await ViewRouterServiceContainer.use().handleViewRequest(req);
      }
    });
  }

  public websocket: WebSocketHandler<{ headers: Headers }> = {
    message: (ws, message) => {
      const kernelRun = this.kernel.run.bind(this.kernel);
      // kernelRun(() => {
      //   KernelContext.getStore().broadcastingServiceContainer.run(
      //     ws.data.headers,
      //     () => {
      //       KernelContext.getStore().broadcastingServiceContainer.handleMessage(
      //         ws,
      //         message,
      //       );
      //     },
      //   );
      // });
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
