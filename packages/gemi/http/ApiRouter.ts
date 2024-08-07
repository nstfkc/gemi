import { isConstructor } from "../internal/isConstructor";
import type { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import {
  Controller,
  ResourceController,
  type ControllerMethods,
} from "./Controller";
import { HttpRequest } from "./HttpRequest";
import type { MiddlewareReturnType } from "./Router";

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
  ) {
    this.handler = handler;
    this.methodName = methodName;
    this.method = method;
  }

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

export type RouteHandlers =
  | {
      create: RouteHandler<"POST", any, any, any>;
      list: RouteHandler<"GET", any, any, any>;
    }
  | {
      update: RouteHandler<"PUT", any, any, any>;
      show: RouteHandler<"GET", any, any, any>;
      delete: RouteHandler<"DELETE", any, any, any>;
    };

export type ApiRoutes = Record<
  string,
  RouteHandler<any, any, any, any> | RouteHandlers | typeof ApiRouter
>;

export class ApiRouter {
  public routes: ApiRoutes = {};
  public middlewares: string[] = [];
  public middleware(_req: HttpRequest<any, any>): MiddlewareReturnType {}

  public get<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"GET", Input, Output, Params>;
  public get<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "GET">;
  public get<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("GET", handler, methodName);
  }

  public post<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"POST", Input, Output, Params>;
  public post<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "POST">;
  public post<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("POST", handler, methodName);
  }

  public put<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PUT", Input, Output, Params>;
  public put<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "PUT">;
  public put<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PUT", handler, methodName);
  }

  public patch<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"PATCH", Input, Output, Params>;
  public patch<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "PATCH">;
  public patch<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("PATCH", handler, methodName);
  }

  public delete<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): RouteHandler<"DELETE", Input, Output, Params>;
  public delete<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): ParseRouteHandler<T, K, "DELETE">;
  public delete<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new RouteHandler("DELETE", handler, methodName);
  }

  public resource<T extends new () => ResourceController>(Controller: T) {
    class ResourceRouter extends ApiRouter {
      routes = {
        "/": {
          list: this.get(
            Controller,
            "list" as ControllerMethods<T>,
          ) as ParseRouteHandler<T, TestControllerMethod<T, "list">, "GET">,
          create: this.post(
            Controller,
            "create" as ControllerMethods<T>,
          ) as ParseRouteHandler<T, TestControllerMethod<T, "create">, "POST">,
        },
        "/:id": {
          show: this.get(
            Controller,
            "show" as ControllerMethods<T>,
          ) as ParseRouteHandler<T, TestControllerMethod<T, "show">, "GET">,
          update: this.put(
            Controller,
            "update" as ControllerMethods<T>,
          ) as ParseRouteHandler<T, TestControllerMethod<T, "update">, "PUT">,
          delete: this.delete(
            Controller,
            "delete" as ControllerMethods<T>,
          ) as ParseRouteHandler<
            T,
            TestControllerMethod<T, "delete">,
            "DELETE"
          >,
        },
      };
    }
    return ResourceRouter;
  }
}

type TestControllerMethod<T extends new () => Controller, K extends string> =
  K extends ControllerMethods<T> ? K : never;

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
      [K in keyof T]: T[K] extends RouteHandler<
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
    }[keyof T]
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
    : T["routes"][K] extends new () => ApiRouter
      ? RouterInstanceParser<T["routes"][K], `${Prefix & string}${K & string}`>
      : T["routes"][K] extends RouteHandlers
        ? RouteHandlersParser<
            T["routes"][K],
            `${Prefix & string}${K extends "/" ? "" : K & string}`
          >
        : never;
}[keyof T["routes"]];

export type CreateRPC<
  T extends ApiRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RouteParser<T, Prefix>>;
