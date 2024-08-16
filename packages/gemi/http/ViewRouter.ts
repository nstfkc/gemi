import type { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import { Controller } from "./Controller";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

export type ViewRoutes = Record<
  string,
  | ViewRoute<any, any, any>
  | LayoutRoute<any, any, any, any>
  | (new () => ViewRouter)
>;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

export type ViewHandler<Input, Output, Params> =
  | CallbackHandler<Input, Output, Params>
  | (new () => Controller);

type ParseViewControllerHandler<
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (
  req: HttpRequest<infer Input, infer Params>,
) => infer Output
  ? ViewRoute<Input, Output, Params>
  : never;

type ParseLayoutControllerHandler<
  T extends ViewRoutes,
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (
  req: HttpRequest<infer Input, infer Params>,
) => infer Output
  ? LayoutRoute<T, Input, Output, Params>
  : never;

export class ViewRoute<Input, Output, Params> {
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output;
  constructor(
    public viewPath: string,
    handler?:
      | CallbackHandler<Input, Output, Params>
      | [new () => Controller, ControllerMethods<any>],
  ) {
    if (!handler) {
      this.handler = (() => ({})) as any;
    } else if (typeof handler === "function") {
      this.handler = handler as any;
    } else {
      const [controller, methodName] = handler;
      const controllerInstance = new controller();
      const controllerHandler =
        controllerInstance[methodName].bind(controllerInstance);
      this.handler = (req: HttpRequest<Input, Params>): Output => {
        let httpRequest = req;
        httpRequest = controllerInstance.requests[methodName]
          ? new controllerInstance.requests[methodName](
              req.rawRequest,
              req.params,
            )
          : httpRequest;
        return controllerHandler(req);
      };
    }
  }

  async run(req: HttpRequest<Input, Params>) {
    return {
      [this.viewPath]: await this.handler(req),
    };
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export class LayoutRoute<T extends ViewRoutes, Input, Output, Params> {
  children: new () => ViewRouter;
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output =
    (() => ({})) as any;
  constructor(
    public viewPath: string,
    handlerOrRoutes:
      | CallbackHandler<Input, Output, Params>
      | [new () => Controller, ControllerMethods<any>]
      | T,
    routes?: T,
  ) {
    if (typeof handlerOrRoutes === "function") {
      this.handler = handlerOrRoutes as any;
      this.children = class extends ViewRouter {
        routes = routes ?? ({} as T);
      };
    } else if (Array.isArray(handlerOrRoutes)) {
      const [controller, methodName] = handlerOrRoutes;
      const controllerInstance = new controller();
      const controllerHandler =
        controllerInstance[methodName].bind(controllerInstance);
      this.handler = (req: HttpRequest<Input, Params>): Output => {
        let httpRequest = req;
        httpRequest = controllerInstance.requests[methodName]
          ? new controllerInstance.requests[methodName](
              req.rawRequest,
              req.params,
            )
          : httpRequest;
        return controllerHandler(req);
      };
      this.children = class extends ViewRouter {
        routes = routes ?? ({} as T);
      };
    } else {
      this.children = class extends ViewRouter {
        routes = handlerOrRoutes as T;
      };
      this.handler = () => ({}) as Output;
    }
  }

  async run(req: HttpRequest<Input, Params>) {
    return {
      [this.viewPath]: await this.handler(req),
    };
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

export class ViewRouter {
  middlewares: string[] = [];
  routes: ViewRoutes = {};

  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M],
  ): ParseViewControllerHandler<C, M>;
  public view<Input, Output, Params>(
    viewPath: string,
    handler?: ViewHandler<Input, Output, Params>,
  ): ViewRoute<Input, Output, Params>;
  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M] | ViewHandler<any, any, any>,
  ) {
    return new ViewRoute(viewPath, handler as any);
  }

  public layout<T extends ViewRoutes>(
    viewPath: string,
    handlerOrRoutes: T,
    routes?: T,
  ): LayoutRoute<T, any, any, any>;
  public layout<
    T extends ViewRoutes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(
    viewPath: string,
    handlerOrRoutes: [C, M],
    routes?: T,
  ): ParseLayoutControllerHandler<T, C, M>;
  public layout<T extends ViewRoutes, Input, Output, Params>(
    viewPath: string,
    handlerOrRoutes: CallbackHandler<Input, Output, Params>,
    routes?: T,
  ): LayoutRoute<T, Input, Output, Params>;
  public layout<
    T extends ViewRoutes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(
    viewPath: string,
    handlerOrRoutes: ViewHandler<any, any, any> | [C, M] | T,
    routes?: T,
  ) {
    return new LayoutRoute(viewPath, handlerOrRoutes as any, routes);
  }
}

type ViewRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends ViewRoute<infer Input, infer Output, infer Params>
    ? KeyAndValue<`view:${Prefix & string}`, ViewHandler<Input, Output, Params>>
    : never;

type LayoutRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends LayoutRoute<infer Routes, infer I, infer O, infer P>
    ?
        | RoutesParser<Routes, Prefix>
        | KeyAndValue<`layout:${Prefix & string}`, ViewHandler<I, O, P>>
    : never;

type ParsePrefixAndKey<
  P extends PropertyKey,
  K extends PropertyKey,
> = `${P & string}${K & string}` extends "//"
  ? "/"
  : `${P & string}${K & string}` extends `${infer U}//${infer T}`
    ? `${U}/${T}`
    : `${P & string}${K & string}` extends `${infer U}/`
      ? U
      : `${P & string}${K & string}`;

type RouterInstanceParser<
  T extends new () => ViewRouter,
  Prefix extends PropertyKey = "",
> = RoutesParser<InstanceType<T>["routes"], Prefix>;

type RoutesParser<
  T extends ViewRoutes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends new () => ViewRouter
    ? RouterInstanceParser<T[K], ParsePrefixAndKey<Prefix, K>>
    : T[K] extends LayoutRoute<any, any, any, any>
      ? LayoutRouteParser<T[K], ParsePrefixAndKey<Prefix, K>>
      : T[K] extends ViewRoute<any, any, any>
        ? ViewRouteParser<T[K], ParsePrefixAndKey<Prefix, K>>
        : never
  : never;

export type CreateViewRPC<
  T extends ViewRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RoutesParser<T["routes"], Prefix>>;
