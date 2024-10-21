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
  __internal_brand = "RouteHandler";
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

  __internal_use() {
    return {
      run: this.run.bind(this),
      middlewares: this.middlewares,
    };
  }

  run(_req: HttpRequest<Input, Params>) {
    if (isController(this.handler)) {
      const controller = new this.handler();
      const handler = controller[this.methodName].bind(controller);
      return handler();
    } else {
      // @ts-ignore
      return this.handler();
    }
  }

  middleware(middlewareList: string[]) {
    this.middlewares = middlewareList;
    return this;
  }
}

export class FileHandler {
  constructor(...args: ConstructorParameters<typeof RouteHandler>) {
    return new RouteHandler(...args) as any;
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

type IdKey<T> = `/:${T & string}`;

export type ApiRoutes = Record<
  string,
  | RouteHandler<any, any, any, any>
  | FileHandler
  | RouteHandlers
  | typeof ApiRouter
  | ((resourceId: string) => ResourceRoutes<any, string>)
>;

export type ResourceRoutes<
  T extends new () => ResourceController,
  U extends PropertyKey,
> = Record<
  "/",
  {
    list: ParseRouteHandler<T, TestControllerMethod<T, "list">, "GET">;
    create: ParseRouteHandler<T, TestControllerMethod<T, "create">, "POST">;
  }
> &
  Record<
    IdKey<U>,
    {
      show: ParseRouteHandler<T, TestControllerMethod<T, "show">, "GET">;
      update: ParseRouteHandler<T, TestControllerMethod<T, "update">, "PUT">;
      delete: ParseRouteHandler<T, TestControllerMethod<T, "delete">, "DELETE">;
    }
  >;

export class ApiRouter {
  static __brand = "ApiRouter";
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
    return <U extends PropertyKey>(resourceId: U) => {
      return {
        "/": {
          list: new RouteHandler("GET", Controller, "list"),
          create: new RouteHandler("POST", Controller, "create"),
        },
        [`/:${String(resourceId)}`]: {
          show: new RouteHandler("GET", Controller, "show"),
          update: new RouteHandler("PUT", Controller, "update"),
          delete: new RouteHandler("DELETE", Controller, "delete"),
        },
      } as ResourceRoutes<T, U>;
    };
  }

  public file<Input, Output, Params>(
    handler: CallbackHandler<Input, Output, Params>,
  ): FileHandler;
  public file<T extends new () => Controller, K extends ControllerMethods<T>>(
    handler: T,
    methodName: K,
  ): FileHandler;
  public file<
    T extends CallbackHandler<any, any, any> | (new () => Controller),
    K extends ControllerMethods<any>,
  >(handler: T, methodName?: K) {
    return new FileHandler("GET", handler, methodName);
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
  ? RouteParser<InstanceType<T>["routes"], `${Prefix & string}`>
  : never;

type ParsePrefixAndKey<
  P extends PropertyKey,
  K extends PropertyKey,
  U = `${P & string}${K & string}`,
> = U extends "//"
  ? "/"
  : U extends `${infer T1}//${infer T2}`
    ? `${T1}/${T2}`
    : U extends `${infer T1}/${infer T2}/`
      ? `${T1}/${T2}`
      : U;

type LastUrlSegment<T extends string> =
  T extends `${infer _}/${infer LastSegment}` ? LastUrlSegment<LastSegment> : T;

type ToCamelCase<T extends string> = T extends `${infer F}-${infer L}`
  ? `${F}${Capitalize<ToCamelCase<L>>}`
  : T;

type ResourceRoutesParser<
  T extends ResourceRoutes<new () => ResourceController, PropertyKey>,
  U extends PropertyKey,
  K extends keyof T = keyof T,
> = T[K] extends RouteHandlers
  ? K extends "/"
    ? RouteHandlersParser<T[K], `${U & string}`>
    : RouteHandlersParser<
        T[K],
        `${U & string}/:${ToCamelCase<LastUrlSegment<U & string>>}Id`
      >
  : KeyAndValue<"YY", any>;

type RouteParser<
  T extends ApiRoutes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends (
      res: string,
    ) => ResourceRoutes<new () => ResourceController, PropertyKey>
    ? ResourceRoutesParser<ReturnType<T[K]>, ParsePrefixAndKey<Prefix, K>>
    : T[K] extends RouteHandler<any, any, any, any>
      ? RouteHandlerParser<T[K], ParsePrefixAndKey<Prefix, K>>
      : T[K] extends new () => ApiRouter
        ? RouterInstanceParser<T[K], ParsePrefixAndKey<Prefix, K>>
        : T[K] extends RouteHandlers
          ? RouteHandlersParser<
              T[K],
              `${Prefix & string}${K extends "/" ? "" : K & string}`
            >
          : never
  : never;

export type CreateRPC<
  T extends ApiRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RouteParser<T["routes"], Prefix>>;
