import type { HttpRequest } from "./HttpRequest";

export class Controller {
  static kind = "controller" as const;

  constructor() {}
}

type PromiseOrData<T> = T | Promise<T>;

export abstract class ResourceController extends Controller {
  abstract create(req: HttpRequest<any, any>): PromiseOrData<any>;
  abstract update(req: HttpRequest<any, any>): PromiseOrData<any>;
  abstract delete(req: HttpRequest<any, any>): PromiseOrData<any>;
  abstract list(req: HttpRequest<any, any>): PromiseOrData<any>;
  abstract show(req: HttpRequest<any, any>): PromiseOrData<any>;
}

export type ControllerMethods<
  T extends new () => Controller | ResourceController,
> = {
  [K in keyof InstanceType<T>]: InstanceType<T>[K] extends Function ? K : never;
}[keyof InstanceType<T>];
