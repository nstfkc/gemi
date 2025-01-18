import { HttpRequest } from "./HttpRequest";

export class Middleware<T extends Record<string, any> = Record<string, any>> {
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
