import { Controller } from "./Controller";
import { type MiddlewareReturnType } from "./Router";
import type { App } from "../app/App";
import { HttpRequest, IHttpRequest } from "./HttpRequest";
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
    req: HttpRequest<{}>,
    params: Record<string, any>,
    app: App,
  ) => Promise<Partial<DataResponse> | ErrorResponse>;
};

type JSONLike = Record<
  string,
  string | number | boolean | { [x: string]: JSONLike } | Array<JSONLike>
>;

type InferCallBackHandlerType<T> = T extends (
  req: HttpRequest<infer Input>,
) => Promise<infer Output> | infer Output
  ? { input: Input; output: Output }
  : never;

type ControllerHandlerType = new (app: App) => Controller;
type CallbackHandlerType<T extends JSONLike> = <U extends Record<string, any>>(
  req: HttpRequest<U>,
) => Promise<T> | T;

type ApiHandler<
  U extends JSONLike = {},
  T extends ControllerHandlerType | CallbackHandlerType<U>,
> = {
  prepare: Prepare;
  middleware: (middleware: string[]) => {
    prepare: Prepare;
  };
};

type RequestHandlerFactory<T extends new (app: App) => Controller> = (
  method: string,
) => ApiHandler<T>;

export type ApiRouteExec = (
  req: HttpRequest<unknown>,
  params: Record<string, string>,
  app: App,
) => Promise<DataResponse | ErrorResponse>;

type ApiRouteConfig = {
  prepare: Prepare;
};

type CallbackHandler<T, R extends HttpRequest<any>> = (
  req: R,
) => Promise<T> | T;

export type ApiRouteChildren = Record<
  string,
  ApiRouteConfig | ApiRouteConfig[] | (new () => ApiRouter)
>;

export type Handler<Input, Output> = (input: Input) => Output;

function isController<T extends new (app: App) => Controller>(
  controller: T | CallbackHandler<any, any>,
  // TODO: fix this
  // @ts-ignore
): controller is new (app: App) => Controller {
  return "kind" in controller && controller.kind === "controller";
}

export class ApiRouter {
  public routes: Record<string, Handler<any, any> | typeof ApiRouter> = {};
  public middlewares: string[] = [];

  constructor() {}

  public middleware(_req: HttpRequest): MiddlewareReturnType {}

  private handleRequest<T, R extends HttpRequest>(
    controller: CallbackHandler<T, R>,
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

  protected get<T, U extends HttpRequest<any>>(
    controller: CallbackHandler<T, U>,
  ): Handler<T, U> {
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
