import { Controller } from "./Controller";
import { type MiddlewareReturnType } from "./Router";
import type { App } from "../app/App";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";

type ControllerMethods<T extends new (app: App) => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type DataResponse = any;
type ErrorResponse = {
  error: any;
};

type Prepare = (middleware?: (Middleware | string)[]) => {
  middleware: string[];
  method: string;
  exec: (
    req: HttpRequest,
    params: Record<string, any>,
    app: App,
  ) => Promise<Partial<DataResponse> | ErrorResponse>;
};

type ApiHandler<T extends new (app: App) => Controller, U = {}> = {
  prepare: Prepare;
  middleware: (middleware: string[]) => {
    prepare: Prepare;
  };
};

type RequestHandlerFactory<T extends new (app: App) => Controller> = (
  method: string,
) => ApiHandler<T>;

export type ApiRouteExec = (
  req: HttpRequest,
  params: Record<string, string>,
  app: App,
) => Promise<DataResponse | ErrorResponse>;

type ApiRouteConfig = {
  prepare: Prepare;
};

type CallbackHandler<T> = (req: HttpRequest) => Promise<T> | T;

export type ApiRouteChildren = Record<
  string,
  ApiRouteConfig | ApiRouteConfig[] | (new () => ApiRouter)
>;

function isController<T extends new (app: App) => Controller>(
  controller: T | CallbackHandler<any>,
  // TODO: fix this
  // @ts-ignore
): controller is new (app: App) => Controller {
  return "kind" in controller && controller.kind === "controller";
}

export class ApiRouter {
  public routes: Record<string, any> = {};
  public middlewares: string[] = [];

  constructor() {}

  public middleware(_req: HttpRequest): MiddlewareReturnType {}

  private handleRequest<T>(
    controller: CallbackHandler<T>,
  ): RequestHandlerFactory<any>;
  private handleRequest<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): RequestHandlerFactory<T>;
  private handleRequest<T extends new (app: App) => Controller, U>(
    controller: T | CallbackHandler<U>,
    methodName?: ControllerMethods<T>,
  ): RequestHandlerFactory<T> {
    return (method: string): ApiHandler<T> => {
      const prepare = (middleware: string[] = []) => {
        return {
          middleware,
          method,
          exec: async (
            req: HttpRequest,
            params: Record<string, string>,
            app: App,
          ): Promise<DataResponse | ErrorResponse> => {
            let handler = (_req: HttpRequest, params: any) =>
              Promise.resolve({});

            let httpRequest = new HttpRequest(req.rawRequest);
            if (isController(controller)) {
              const controllerInstance = new controller(app);
              const Req =
                controllerInstance.requests[methodName as any] ?? HttpRequest;
              httpRequest = new Req(req.rawRequest);
              handler =
                controllerInstance[methodName as any].bind(controllerInstance);
            } else if (typeof controller === "function") {
              handler = (req: HttpRequest) => controller(req) as any;
            }

            return await handler(httpRequest, params);
          },
        };
      };
      return {
        prepare,
        middleware: (middlware: string[]) => {
          return {
            prepare: () => prepare(middlware),
          };
        },
      };
    };
  }

  protected get<T>(controller: CallbackHandler<T>): ApiHandler<any>;
  protected get<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): ApiHandler<T>;
  protected get<T extends new (app: App) => Controller>(
    controller: T,
    methodName?: ControllerMethods<T>,
  ): ApiHandler<T> {
    const handler = this.handleRequest(controller, methodName);
    return handler("get");
  }

  protected post<T>(controller: CallbackHandler<T>): ApiHandler<any>;
  protected post<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): ApiHandler<T>;
  protected post<T extends new (app: App) => Controller>(
    controller: T,
    methodName?: ControllerMethods<T>,
  ): ApiHandler<T> {
    const handler = this.handleRequest(controller, methodName);
    return handler("post");
  }

  protected put<T>(controller: CallbackHandler<T>): ApiHandler<any>;
  protected put<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): ApiHandler<T>;
  protected put<T extends new (app: App) => Controller>(
    controller: T,
    methodName?: ControllerMethods<T>,
  ): ApiHandler<T> {
    const handler = this.handleRequest(controller, methodName);
    return handler("put");
  }

  protected delete<T>(controller: CallbackHandler<T>): ApiHandler<any>;
  protected delete<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): ApiHandler<T>;
  protected delete<T extends new (app: App) => Controller>(
    controller: T,
    methodName?: ControllerMethods<T>,
  ): ApiHandler<T> {
    const handler = this.handleRequest(controller, methodName);
    return handler("delete");
  }

  protected patch<T>(controller: CallbackHandler<T>): ApiHandler<any>;
  protected patch<T extends new (app: App) => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ): ApiHandler<T>;
  protected patch<T extends new (app: App) => Controller>(
    controller: T,
    methodName?: ControllerMethods<T>,
  ): ApiHandler<T> {
    const handler = this.handleRequest(controller, methodName);
    return handler("patch");
  }
}
