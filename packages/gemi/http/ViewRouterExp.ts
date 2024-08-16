import { Controller } from "./Controller";
import type { MiddlewareReturnType } from "./Router";
import { HttpRequest } from "./HttpRequest";
import { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

type ViewPrepare = {
  exec: (req: HttpRequest) => any;
  viewPath: string;
  children: ViewChildren;
  middlewares: any[];
  kind: "view" | "layout";
};

export type ViewConfig = {
  prepare: (_middlewares?: any[]) => ViewPrepare;
  middleware: (middlewares: any[]) => ViewConfig;
};

export type ViewChildren = Record<
  string,
  | ViewRouteHandler<any, any, any, any>
  | ViewRouteHandlerWithoutChildren<any, any, any, any>
>;

export type ViewRouteExec = (req: HttpRequest) => any;

type ViewKind = "view" | "layout";

export class ViewRouteHandler<T extends ViewKind, Input, Output, Params> {
  middlewares: string[] = [];
  viewPath: string;
  kind: "view" | "layout";
  children: ViewChildren | undefined;
  private handler:
    | CallbackHandler<Input, Output, Params>
    | [new () => Controller, ControllerMethods<any>];

  constructor(
    viewPath: string,
    kind: "view" | "layout",
    handlerOrChildren?:
      | (
          | CallbackHandler<Input, Output, Params>
          | [new () => Controller, ControllerMethods<any>]
        )
      | ViewChildren,
    children?: ViewChildren,
  ) {
    this.kind = kind;
    this.viewPath = viewPath;
    if (handlerOrChildren) {
      if (handlerOrChildren.constructor === Object) {
        this.children = handlerOrChildren as ViewChildren;
      } else {
        this.children = children ?? {};
        this.handler = handlerOrChildren as
          | CallbackHandler<Input, Output, Params>
          | [new () => Controller, string];
      }
    }
  }

  run(req: HttpRequest<Input, Params>) {
    let httpRequest = req;
    this.handler;
  }

  middleware(middlewareList: string[]) {
    this.middlewares = middlewareList;
    return this;
  }
}

class ViewRouteHandlerWithoutChildren<
  T extends ViewKind,
  I,
  O,
  P,
> extends ViewRouteHandler<T, I, O, P> {
  constructor(
    viewPath: string,
    kind: ViewKind,
    handler: CallbackHandler<any, any, any>,
  ) {
    super(viewPath, kind, handler, {});
  }
}

export class ViewRouter {
  public routes: ViewChildren | Record<never, never> = {};
  public middlewares: string[] = [];

  public middleware(req: Request): MiddlewareReturnType {}

  protected layout(
    viewPath: string,
    handlerOrChildren: ViewChildren,
    maybeChildren?: any,
  ): ViewRouteHandler<"layout", any, any, any>;
  protected layout<I, O, P>(
    viewPath: string,
    handlerOrChildren: CallbackHandler<I, O, P>,
    children: ViewChildren,
  ): ViewRouteHandler<"layout", I, O, P>;
  protected layout<
    T extends new () => Controller,
    K extends ControllerMethods<T>,
  >(
    viewPath: string,
    handlerOrChildren: [T, K],
    children: ViewChildren,
  ): InstanceType<T>[K] extends (req: HttpRequest<infer I, infer P>) => infer O
    ? ViewRouteHandler<"layout", I, O, P>
    : ViewRouteHandler<"layout", any, any, any>;
  protected layout(
    viewPath: string,
    handlerOrChildren: any,
    maybeChildren?: any,
  ): ViewRouteHandler<"layout", any, any, any> {
    return new ViewRouteHandler(
      viewPath,
      "layout",
      handlerOrChildren,
      maybeChildren,
    );
  }

  protected view(
    viewPath: string,
  ): ViewRouteHandlerWithoutChildren<"view", any, any, any> {
    return new ViewRouteHandler(viewPath, "view");
  }

  // protected view<T extends new () => Controller>(
  //   viewPath: string,
  //   ...args: [
  //     handlerOrChildren?: ViewHandler<T> | ViewChildren,
  //     children?: ViewChildren,
  //   ]
  // ): ViewConfig {
  //   // TODO: type middleware
  //   function prepare(middlewares: any[] = []): ViewPrepare {
  //     const [handlerOrChildren, maybeChildren] = args;
  //     let _children = maybeChildren ?? {};
  //     if (handlerOrChildren && handlerOrChildren.constructor === Object) {
  //       _children = handlerOrChildren;
  //     }
  //     return {
  //       exec: async (req: HttpRequest) => {
  //         let _handler = () => Promise.resolve({ [viewPath]: {} });
  //         if (typeof handlerOrChildren === "function") {
  //           _handler = handlerOrChildren;
  //         }

  //         if (Array.isArray(handlerOrChildren)) {
  //           const [controller, methodName] = handlerOrChildren;
  //           const instance = new controller();
  //           _handler = instance[methodName].bind(instance);
  //         }

  //         const data = await _handler(req);
  //         return { [viewPath]: data };
  //       },
  //       children: _children,
  //       viewPath,
  //       middlewares,
  //       kind: "view",
  //     };
  //   }
  //   return {
  //     prepare,
  //     middleware: (middlewares: any[]) => ({
  //       prepare: () => prepare(middlewares),
  //     }),
  //   };
  // }
}

class R extends ViewRouter {
  routes = {
    "/": this.view("Home"),
  };
}

export type ViewRouterHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Output;

type RouteHandlerParser<T, Prefix extends string = ""> =
  T extends ViewRouteHandler<
    infer Kind,
    infer Input,
    infer Output,
    infer Params
  >
    ? KeyAndValue<
        `${Kind & string}:${Prefix & string}`,
        ViewRouterHandler<Input, Output, Params>
      >
    : never;

type ViewChildrenParser<
  T extends ViewChildren,
  Prefix extends string,
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends ViewRouteHandler<any, any, any, any>
    ? RouteHandlerParser<T[K], `${Prefix & string}${K & string}`>
    : T[K] extends new () => ViewRouter
      ? RouterInstanceParser<T[K], `${Prefix & string}${K & string}`>
      : never
  : KeyAndValue<"notempty", "empty">;

type RouterInstanceParser<
  T extends new () => ViewRouter,
  Prefix extends string,
> = T extends new () => ViewRouter
  ? RouteParser<InstanceType<T>, `${Prefix & string}`>
  : never;

type RouteParser<T extends ViewRouter, Prefix extends PropertyKey> = {
  [K in keyof T["routes"]]: T["routes"][K] extends ViewRouteHandler<
    any,
    any,
    any,
    any
  >
    ? RouteHandlerParser<T["routes"][K], `${Prefix & string}${K & string}`>
    : T["routes"][K] extends new () => ViewRouter
      ? RouterInstanceParser<T["routes"][K], `${Prefix & string}${K & string}`>
      : never;
}[keyof T["routes"]];

type CreateViewRPC<
  T extends ViewRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RouteParser<T, Prefix>>;

type RPC = CreateViewRPC<R>;

// view
// nestedView
// layout
