import { HttpRequest } from "./HttpRequest";

export class Middleware<T extends Record<string, any> = Record<string, any>> {
  /**
   * Marks a middleware as gating access to the routes it is attached to. Routes
   * behind such a middleware are stripped from the route manifest, component
   * tree and view loader map that get shipped to anonymous visitors, so the
   * client never learns about pages it cannot reach.
   *
   * `configure()` returns a subclass, and subclasses inherit statics, so both
   * survive the alias lookup in `MiddlewareServiceContainer.isPrivateChain`.
   */
  static isPrivate = false;

  config: T = {} as T;
  constructor(protected req: HttpRequest) {}
  run(..._args: any[]): Promise<any> | any {
    return {};
  }

  static configure<T extends Middleware<any>>(
    this: new (req: HttpRequest<any, any>) => T,
    config: T["config"],
  ) {
    const self = this as any;
    return class extends self {
      config = config;
    } as any;
  }
}
