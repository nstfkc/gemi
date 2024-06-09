// @ts-nocheck

import { Controller } from "./Controller";
import type { MiddlewareReturnType } from "./Router";
import type { App } from "../app/App";

type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];

type ViewHandler<T extends new () => Controller> = [
  controller: T,
  method: ControllerMethods<T>,
];

type ViewPrepare = {
  exec: (req: Request, params: Record<string, string>) => any;
  viewPath: string;
  children: ViewChildren;
  middlewares: any[];
};

type ViewConfig = {
  prepare: (_middlewares?: any[]) => ViewPrepare;
  middlewares: (middlewares: any[]) => {
    prepare: () => ViewPrepare;
  };
};

export type ViewChildren = Record<
  string,
  ViewConfig | (new (app: App) => ViewRouter)
>;

export type ViewRouteExec = (
  req: Request,
  params: Record<string, string>,
) => any;

export class ViewRouter {
  public routes: ViewChildren = {};
  public middlewares: string[] = [];
  constructor() {}

  public middleware(req: Request): MiddlewareReturnType {}

  protected view<T extends new () => Controller>(
    viewPath: string,
    handler?: ViewHandler<T>,
    children: ViewChildren = {},
  ): ViewConfig {
    // TODO: type middleware
    function prepare(middlewares: any[] = []) {
      return {
        exec: async (
          req: Request,
          params: Record<string, string>,
          app: App,
        ) => {
          if (!handler) {
            return { data: { [viewPath]: {} }, headers: {}, head: {} };
          }
          const [controller, methodName] = handler;
          const instance = new controller(app);
          const method = instance[methodName].bind(instance);
          const { data, headers = {}, head = {} } = await method(req, params);
          return { data: { [viewPath]: data }, headers, head };
        },
        children,
        viewPath,
        middlewares,
      };
    }
    return {
      prepare,
      middlewares: (middlewares: any[]) => {
        prepare: () => prepare(middlewares);
      },
    };
  }
}
