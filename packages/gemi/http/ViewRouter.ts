// @ts-nocheck

import { Controller } from "./Controller";
import type { MiddlewareReturnType } from "./Router";
import { HttpRequest } from "./HttpRequest";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type ViewHandler<T extends new () => Controller> =
  | [controller: T, method: ControllerMethods<T>]
  | ((req: HttpRequest) => Promise<any> | any);

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

export type ViewChildren = Record<string, ViewConfig | (new () => ViewRouter)>;

export type ViewRouteExec = (req: HttpRequest) => any;

export class ViewRouter {
  public routes: ViewChildren = {};
  public middlewares: string[] = [];

  public middleware(req: Request): MiddlewareReturnType {}

  protected layout<T extends new () => Controller>(
    viewPath: string,
  ): ViewConfig;
  protected layout<T extends new () => Controller>(
    viewPath: string,
    children: ViewChildren,
  ): ViewConfig;
  protected layout<T extends new () => Controller>(
    viewPath: string,
    handler: ViewHandler<T>,
  ): ViewConfig;
  protected layout<T extends new () => Controller>(
    viewPath: string,
    handler: ViewHandler<T> | ViewChildren,
    children: ViewChildren,
  ): ViewConfig {
    // TODO: type middleware
    function prepare(middlewares: any[] = []): ViewPrepare {
      let _children = children ?? {};
      if (handler && handler.constructor === Object) {
        _children = handler;
      }
      return {
        exec: async (req: HttpRequest) => {
          let _handler = () =>
            Promise.resolve({
              data: { [viewPath]: {} },
              headers: {},
              head: {},
            });
          if (typeof handler === "function") {
            _handler = handler;
          }

          if (Array.isArray(handler)) {
            const [controller, methodName] = handler;
            const instance = new controller(app);
            _handler = instance[methodName].bind(instance);
          }

          const data = await _handler(req);
          return { [viewPath]: data };
        },
        children: _children,
        viewPath,
        middlewares,
        kind: "layout",
      };
    }
    return {
      prepare,
      middleware: (middlewares: any[]) => ({
        prepare: () => prepare(middlewares),
      }),
    };
  }

  protected view<T extends new () => Controller>(viewPath: string): ViewConfig;
  protected view<T extends new () => Controller>(
    viewPath: string,
    children: ViewChildren,
  ): ViewConfig;
  protected view<T extends new () => Controller>(
    viewPath: string,
    handler: ViewHandler<T>,
  ): ViewConfig;
  protected view<T extends new () => Controller>(
    viewPath: string,
    handler: ViewHandler<T> | ViewChildren,
    children: ViewChildren,
  ): ViewConfig {
    // TODO: type middleware
    function prepare(middlewares: any[] = []): ViewPrepare {
      let _children = children ?? {};
      if (handler && handler.constructor === Object) {
        _children = handler;
      }
      return {
        exec: async (req: HttpRequest) => {
          let _handler = () =>
            Promise.resolve({
              data: { [viewPath]: {} },
              headers: {},
              head: {},
            });
          if (typeof handler === "function") {
            _handler = handler;
          }

          if (Array.isArray(handler)) {
            const [controller, methodName] = handler;
            const instance = new controller(app);
            _handler = instance[methodName].bind(instance);
          }

          const data = await _handler(req);
          return { [viewPath]: data };
        },
        children: _children,
        viewPath,
        middlewares,
        kind: "view",
      };
    }
    return {
      prepare,
      middleware: (middlewares: any[]) => ({
        prepare: () => prepare(middlewares),
      }),
    };
  }
}
