import type { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";
import type { WebSocketHandler } from "bun";
import { ComponentType } from "react";
import { Kernel } from "../kernel";
import { I18nServiceContainer } from "../http/I18nServiceContainer";
import { KernelContext } from "../kernel/KernelContext";

interface AppParams {
  viewRouter: new () => ViewRouter;
  apiRouter: new () => ApiRouter;
  root: ComponentType;
  kernel: new () => Kernel;
}

export class App {
  public name = "APP";
  public devVersion = 0;
  private apiRouter: new () => ApiRouter;
  private viewRouter: new () => ViewRouter;
  private Root: ComponentType;
  private kernel: Kernel;
  private i18nServiceContainer: I18nServiceContainer;

  constructor(params: AppParams) {
    this.apiRouter = params.apiRouter;
    this.viewRouter = params.viewRouter;
    this.Root = params.root;
    this.kernel = new params.kernel();

    this.prepare();

    this.i18nServiceContainer = this.kernel.getServices().i18nServiceContainer;
    this.i18nServiceContainer.boot();
  }

  private prepare() {
    const kernelServices = this.kernel.getServices();

    const authBasePath =
      kernelServices.authenticationServiceContainer.provider.basePath;

    let viewRouters = {
      "/": this.viewRouter,
      [authBasePath]:
        kernelServices.authenticationServiceContainer.provider.routers.view,
    };
    let apiRouters = {
      "/": this.apiRouter,
      [authBasePath]:
        kernelServices.authenticationServiceContainer.provider.routers.api,
      "/__gemi__/services/i18n":
        kernelServices.i18nServiceContainer.routers.api,
    };

    this.kernel
      .getServices()
      .apiRouterServiceContainer.service.boot(apiRouters);

    this.kernel
      .getServices()
      .viewRouterServiceContainer.service.boot(viewRouters, this.Root);
  }

  public getComponentTree() {
    return this.kernel.getServices().viewRouterServiceContainer.service
      .componentTree;
  }

  public getFlatComponentTree() {
    return this.kernel.getServices().viewRouterServiceContainer.service
      .flatComponentTree;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    const kernelRun = this.kernel.run.bind(this.kernel);

    return kernelRun(async () => {
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
    this.kernel.services.broadcastingServiceContainer.onPublish(fn);
  }
}
