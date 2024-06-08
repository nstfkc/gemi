//@ts-nocheck

import type { Controller } from "./Controller";
import { type MiddlewareReturnType } from "./Router";
import type { App } from "../app/App";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
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

type ApiHandler<T extends new () => Controller> = (
  controller: T,
  method: ControllerMethods<T>,
) => {
  exec: (
    req: Request,
    params: Record<string, any>,
  ) => Promise<DataResponse | ErrorResponse>;
};

export type ApiRouteExec = (
  req: Request,
  params: Record<string, string>,
) => Promise<DataResponse | ErrorResponse>;

type ApiRouteConfig = {
  method: string;
  exec: ApiRouteExec;
};

export type ApiRouteChildren = Record<
  string,
  ApiRouteConfig | ApiRouteConfig[] | (new (app: App) => ApiRouter)
>;

export class ApiRouter {
  public routes: Record<string, any> = {};
  public middlewares: string[] = [];

  constructor() {}

  public middleware(req: Request): MiddlewareReturnType {}

  private handleRequest<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    return (method: string) => {
      return {
        method,
        exec: async (
          req: Request,
          params: Record<string, string>,
        ): Promise<DataResponse | ErrorResponse> => {
          const controllerInstance = new controller();
          const handler =
            controllerInstance[methodName].bind(controllerInstance);
          const Req = controllerInstance.requests[methodName] ?? HttpRequest;
          const httpRequest = new Req(req);
          const {
            data,
            status = method === "post" ? 201 : 200,
            headers = {},
            cookies = {},
          } = await handler(httpRequest, params);
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

  protected get<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    const handler = this.handleRequest(controller, methodName);
    return handler("get");
  }

  protected post<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    const handler = this.handleRequest(controller, methodName);
    return handler("post");
  }

  protected patch<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    const handler = this.handleRequest(controller, methodName);
    return handler("patch");
  }

  protected put<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    const handler = this.handleRequest(controller, methodName);
    return handler("put");
  }

  protected delete<T extends new () => Controller>(
    controller: T,
    methodName: ControllerMethods<T>,
  ) {
    const handler = this.handleRequest(controller, methodName);
    return handler("delete");
  }
}
