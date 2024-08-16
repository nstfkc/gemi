import { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import { Controller } from "./Controller";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type Routes = Record<
  string,
  ViewRoute<any, any, any> | LayoutRoute<any, any, any, any> | ViewRouter
>;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

type Handler<Input, Output, Params> =
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
  T extends Routes,
  C extends new () => Controller,
  M extends ControllerMethods<C>,
> = InstanceType<C>[M] extends (
  req: HttpRequest<infer Input, infer Params>,
) => infer Output
  ? LayoutRoute<T, Input, Output, Params>
  : never;

class ViewRoute<Input, Output, Params> {
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output;
  constructor(
    public viewPath: string,
    handler:
      | CallbackHandler<Input, Output, Params>
      | [new () => Controller, ControllerMethods<any>],
  ) {
    if (typeof handler === "function") {
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
    return this.handler(req);
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

class LayoutRoute<T extends Routes, Input, Output, Params> {
  children: T;
  middlewares: string[] = [];
  private handler: (req: HttpRequest<Input, Params>) => Output;
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
      this.children = routes ?? ({} as T);
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
      this.children = routes ?? ({} as T);
    } else {
      this.children = handlerOrRoutes;
      this.handler = () => ({}) as Output;
    }
  }

  run(req: HttpRequest<Input, Params>) {
    return this.handler(req);
  }

  middleware(middlewares: string[]) {
    this.middlewares = middlewares;
    return this;
  }
}

class ViewRouter {
  routes = {};

  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M],
  ): ParseViewControllerHandler<C, M>;
  public view<Input, Output, Params>(
    viewPath: string,
    handler?: Handler<Input, Output, Params>,
  ): ViewRoute<Input, Output, Params>;
  public view<C extends new () => Controller, M extends ControllerMethods<C>>(
    viewPath: string,
    handler?: [C, M] | Handler<any, any, any>,
  ) {
    return new ViewRoute(viewPath, handler as any);
  }

  public layout<T extends Routes>(
    viewPath: string,
    handlerOrRoutes: T,
    routes?: T,
  ): LayoutRoute<T, never, never, never>;
  public layout<
    T extends Routes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(
    viewPath: string,
    handlerOrRoutes: [C, M],
    routes?: T,
  ): ParseLayoutControllerHandler<T, C, M>;
  public layout<T extends Routes, Input, Output, Params>(
    viewPath: string,
    handlerOrRoutes: CallbackHandler<Input, Output, Params>,
    routes?: T,
  ): LayoutRoute<T, Input, Output, Params>;
  public layout<
    T extends Routes,
    C extends new () => Controller,
    M extends ControllerMethods<C>,
  >(
    viewPath: string,
    handlerOrRoutes: Handler<any, any, any> | [C, M] | T,
    routes?: T,
  ) {
    return new LayoutRoute(viewPath, handlerOrRoutes as any, routes);
  }
}

type ViewRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends ViewRoute<infer Input, infer Output, infer Params>
    ? KeyAndValue<`view:${Prefix & string}`, Handler<Input, Output, Params>>
    : never;

type LayoutRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends LayoutRoute<infer Routes, infer I, infer O, infer P>
    ?
        | RoutesParser<Routes, Prefix>
        | KeyAndValue<`layout:${Prefix & string}`, Handler<I, O, P>>
    : never;

type RouterInstanceParser<
  T extends new () => ViewRouter,
  Prefix extends PropertyKey = "",
> = RoutesParser<InstanceType<T>["routes"], Prefix>;

type RoutesParser<
  T extends Routes,
  Prefix extends PropertyKey = "",
  K extends keyof T = keyof T,
> = K extends any
  ? T[K] extends new () => ViewRouter
    ? RouterInstanceParser<
        T[K],
        `${Prefix & string}${K extends "/" ? "" : K & string}`
      >
    : T[K] extends LayoutRoute<any, any, any, any>
      ? LayoutRouteParser<
          T[K],
          `${Prefix & string}${K extends "/" ? "" : K & string}`
        >
      : T[K] extends ViewRoute<any, any, any>
        ? ViewRouteParser<
            T[K],
            `${Prefix & string}${K extends "/" ? "" : K & string}`
          >
        : never
  : never;

type CreateRPC<
  T extends ViewRouter,
  Prefix extends PropertyKey = "",
> = KeyAndValueToObject<RoutesParser<T["routes"], Prefix>>;

class Cont extends Controller {
  list(req: HttpRequest<{ query: string }>) {
    return { list: true };
  }
  show(req: HttpRequest<{ query: string }, { id: string }>) {
    return { show: true };
  }
}

class Foo extends ViewRouter {
  routes = {
    "/x": this.view("View", [Cont, "list"]),
    "/y": this.layout("Layout", {
      "/z": this.view("View"),
    }),
  };
}

class Ex extends ViewRouter {
  routes = {
    // "/foo": this.view("View", () => {
    //   return { foo: "bar" };
    // }),
    // "/list": this.view("View", [Cont, "list"]),
    // "/show": this.view("View", [Cont, "show"]),
    "/bar": this.layout(
      "Layout",
      async (req: HttpRequest) => {
        const input = await req.input();
        return { layout: "layout" };
      },
      {
        "/bux": this.view("View", [Cont, "show"]),
      },
    ),
    // "/baz": Foo,
  };
}

type Result = CreateRPC<Ex>;
