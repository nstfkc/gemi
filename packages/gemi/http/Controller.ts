import type { HttpRequest } from "./HttpRequest";

export class Controller {
  requests: Record<string, typeof HttpRequest<any, any>> = {};

  static kind = "controller" as const;

  constructor() {}
}

export type ControllerMethods<T extends new () => Controller> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];
