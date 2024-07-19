import { isConstructor } from "../internal/isConstructor";
import { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import { Controller, ControllerMethods } from "./Controller";
import type { HttpRequest } from "./HttpRequest";
import { MiddlewareReturnType } from "./Router";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiRouterHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Output;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

type ParseRouteHandler<
  T extends new () => Controller,
  K extends ControllerMethods<T>,
  M extends HttpMethod,
> = InstanceType<T>[K] extends (
  req: HttpRequest<infer Input, infer Params>,
) => infer Output
  ? RouteHandler<M, Input, Output, Params>
  : never;

function isController(
  candidate: CallbackHandler<any, any, any> | (new () => Controller),
): candidate is new () => Controller {
  return isConstructor(candidate);
}

export class RouteHandler<M extends HttpMethod, Input, Output, Params> {
  middlewares: string[] = [];

  constructor(
    public method: M,
    private handler:
      | CallbackHandler<Input, Output, Params>
      | (new () => Controller),
    private methodName?: any,
  ) {}

  run(req: HttpRequest<Input, Params>) {
    let httpRequest = req;
    if (isController(this.handler)) {
      const controller = new this.handler();
      const handler = controller[this.methodName].bind(controller);
      httpRequest = controller.requests[this.methodName]
        ? new controller.requests[this.methodName](req.rawRequest, req.params)
        : httpRequest;
      return handler(httpRequest);
    } else {
      return this.handler(req);
    }
  }

  middleware(middlewareList: string[]) {
    this.middlewares = middlewareList;
    return this;
  }
}

type RouteHandlers = RouteHandler<any, any, any, any>[];

export type ApiRoutes = Record<
  string,
  RouteHandler<any, any, any, any> | RouteHandlers | typeof ApiRouter
>;

export class ApiRouter {
  public routes: ApiRoutes = {};
  public middlewares: string[] = [];
  public middleware(_req: HttpRequest<any, any>): MiddlewareReturnType {}

  protected get<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"GET", Input, Output, Params>;
  protected get<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "GET">;
  protected get<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("GET", handler, methodName);
  }

  protected post<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"POST", Input, Output, Params>;
  protected post<
    T extends new () => Controller,
    K extends ControllerMethods<T>,
  >(handler: T, methodName: K): ParseRouteHandler<T, K, "POST">;
  protected post<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("POST", handler, methodName);
  }

  protected put<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PUT", Input, Output, Params>;
  protected put<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "PUT">;
  protected put<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PUT", handler, methodName);
  }

  protected patch<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PATCH", Input, Output, Params>;
  protected patch<
    T extends new () => Controller,
    K extends ControllerMethods<T>,
  >(handler: T, methodName: K): ParseRouteHandler<T, K, "PATCH">;
  protected patch<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PATCH", handler, methodName);
  }

  protected delete<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"DELETE", Input, Output, Params>;
  protected delete<
    T extends new () => Controller,
    K extends ControllerMethods<T>,
  >(handler: T, methodName: K): ParseRouteHandler<T, K, "DELETE">;
  protected delete<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("DELETE", handler, methodName);
  }
}

type RouteHandlerParser<T, Prefix extends string = ""> =
  T extends RouteHandler<infer Method, infer Input, infer Output, infer Params>
    ? KeyAndValue<
        `${Method & string}:${Prefix & string}`,
        ApiRouterHandler<Input, Output, Params>
      >
    : never;

type RouteHandlersParser<
  T,
  Prefix extends string = "",
> = T extends RouteHandlers
  ? {
      [K in keyof RouteHandlers]: T[K] extends RouteHandler<
        infer Method,
        infer Input,
        infer Output,
        infer Params
      >
        ? KeyAndValue<
            `${Method & string}:${Prefix & string}`,
            ApiRouterHandler<Input, Output, Params>
          >
        : never;
    }[number]
  : never;

type RouterInstanceParser<
  T extends new () => ApiRouter,
  Prefix extends string,
> = T extends new () => ApiRouter
  ? RouteParser<InstanceType<T>, `${Prefix & string}`>
  : never;

type RouteParser<T extends ApiRouter, Prefix extends PropertyKey = ""> = {
  [K in keyof T["routes"]]: T["routes"][K] extends RouteHandler<
    any,
    any,
    any,
    any
  >
    ? RouteHandlerParser<T["routes"][K], `${Prefix & string}${K & string}`>
    : T["routes"][K] extends RouteHandlers
      ? RouteHandlersParser<T["routes"][K], `${Prefix & string}${K & string}`>
      : T["routes"][K] extends new () => ApiRouter
        ? RouterInstanceParser<
            T["routes"][K],
            `${Prefix & string}${K & string}`
          >
        : never;
}[keyof T["routes"]];

export type CreateRPC<
  T extends ApiRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RouteParser<T, Prefix>>;
