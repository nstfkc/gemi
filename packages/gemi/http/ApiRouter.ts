import { Controller } from "./Controller";
import { type MiddlewareReturnType } from "./Router";
import type { App } from "../app/App";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new (app: App) => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type DataResponse = {
  data: any;
  status: number;
  headers: Record<string, string>;
  cookies: Record<string, string>;
};
type ErrorResponse = {
  error: any;
  status: number;
  headers: Record<string, string>;
  cookies: Record<string, string>;
};

type ApiHandler<T extends new (app: App) => Controller, U = {}> = {
  method: string;
  exec: (
    req: Request,
    params: Record<string, any>,
    app: App,
  ) => Promise<Partial<DataResponse> | ErrorResponse>;
};

type RequestHandlerFactory<T extends new (app: App) => Controller> = (
  method: string,
) => ApiHandler<T>;

export type ApiRouteExec = (
  req: Request,
  params: Record<string, string>,
) => Promise<DataResponse | ErrorResponse>;

type ApiRouteConfig = {
  method: string;
  exec: ApiRouteExec;
};

type CallbackHandler<T> = (req: HttpRequest) => Promise<T> | T;

export type ApiRouteChildren = Record<
  string,
  ApiRouteConfig | ApiRouteConfig[] | (new (app: App) => ApiRouter)
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

  public middleware(_req: Request): MiddlewareReturnType {}

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
      return {
        method,
        exec: async (
          req: Request,
          params: Record<string, string>,
          app: App,
        ): Promise<DataResponse | ErrorResponse> => {
          let _handler = (_req: Request | HttpRequest, params: any) =>
            Promise.resolve({
              data: { message: "hello" },
              status: 200,
              headers: {},
              cookies: {},
            });

          let httpRequest = new HttpRequest(req);
          if (isController(controller)) {
            const controllerInstance = new controller(app);
            const Req =
              controllerInstance.requests[methodName as any] ?? HttpRequest;
            httpRequest = new Req(req);
            _handler =
              controllerInstance[methodName as any].bind(controllerInstance);
          } else if (typeof controller === "function") {
            console.log("here");
            _handler = (req: Request) =>
              controller(new HttpRequest(req)) as any;
          }

          const {
            data,
            status = method === "post" ? 201 : 200,
            headers = {},
            cookies = {},
          } = await _handler(httpRequest, params);

          return {
            data,
            status,
            headers,
            cookies,
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
