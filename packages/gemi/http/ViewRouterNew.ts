import { KeyAndValue, KeyAndValueToObject } from "../internal/type-utils";
import { Controller } from "./Controller";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type Routes = Record<
  string,
  | ViewRoute<any, any, any, any>
  | LayoutRoute<any, any, any, any, any>
  | ViewRouter
>;

type RouteHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

type CallbackHandler<Input, Output, Params> = (
  req: HttpRequest<Input, Params>,
) => Promise<Output> | Output;

type ControllerAndMethodHandler<
  C extends new () => Controller,
  Input,
  Output,
  Params,
> = [C, ControllerMethods<C>];

type Handler<C extends new () => Controller, Input, Output, Params> =
  | CallbackHandler<Input, Output, Params>
  | ControllerAndMethodHandler<C, Input, Output, Params>;

class ViewRoute<C extends new () => Controller, Input, Output, Params> {
  constructor(viewPath: string, handler: Handler<C, Input, Output, Params>) {}
}

class LayoutRoute<
  T extends Routes,
  C extends new () => Controller,
  Input,
  Output,
  Params,
> {
  children: T;
  constructor(
    viewPath: string,
    handlerOrRoutes: Handler<C, Input, Output, Params> | T,
    routes: T,
  ) {}
}

class ViewRouter {
  routes = {};

  public view<C extends new () => Controller, Input, Output, Params>(
    viewPath: string,
    handler?: Handler<C, Input, Output, Params>,
  ): ViewRoute<C, Input, Output, Params> {
    return new ViewRoute(viewPath, handler);
  }

  public layout<
    T extends Routes,
    C extends new () => Controller,
    Input,
    Output,
    Params,
  >(
    viewPath: string,
    handlerOrRoutes: T,
    _routes?: any,
  ): LayoutRoute<T, C, Input, Output, Params>;
  public layout<
    T extends Routes,
    C extends new () => Controller,
    Input,
    Output,
    Params,
  >(
    viewPath: string,
    handler: CallbackHandler<Input, Output, Params>,
    routes: T,
  ): LayoutRoute<T, C, Input, Output, Params>;
  public layout<
    T extends Routes,
    C extends new () => Controller,
    Input,
    Output,
    Params,
  >(
    viewPath: string,
    handler: ControllerAndMethodHandler<C, Input, Output, Params>,
    routes: T,
  ): LayoutRoute<T, C, Input, Output, Params>;
  public layout<
    T extends Routes,
    C extends new () => Controller,
    Input,
    Output,
    Params,
  >(
    viewPath: string,
    handlerOrRoutes: Handler<C, Input, Output, Params> | T,
    routes?: T,
  ): LayoutRoute<T, C, Input, Output, Params> {
    return new LayoutRoute(viewPath, handlerOrRoutes, routes);
  }
}

type ViewRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends ViewRoute<infer C, infer Input, infer Output, infer Params>
    ? KeyAndValue<
        `view:${Prefix & string}`,
        RouteHandler<Input, Output, Params>
      >
    : never;

type LayoutRouteParser<T, Prefix extends PropertyKey = ""> =
  T extends LayoutRoute<infer Routes, any, any, any, any>
    ?
        | RoutesParser<Routes, Prefix>
        | KeyAndValue<`layout:${Prefix & string}`, "layout">
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
    : T[K] extends LayoutRoute<any, any, any, any, any>
      ? LayoutRouteParser<
          T[K],
          `${Prefix & string}${K extends "/" ? "" : K & string}`
        >
      : T[K] extends ViewRoute<any, any, any, any>
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
    "/x": this.view("View"),
    "/y": this.layout("Layout", {
      "/z": this.view("View"),
    }),
  };
}

class Ex extends ViewRouter {
  routes = {
    "/foo": this.view("View", () => {
      return { foo: "bar" };
    }),
    "/list": this.view("View", [Cont, "list"]),
    "/bar": this.layout("Layout", {
      "/bux": this.view("View"),
    }),
    "/baz": Foo,
  };
}

type Result = CreateRPC<Ex>;
