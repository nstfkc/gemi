import { HttpRequest } from "./HttpRequest";

export class Middleware<T extends Record<string, any> = Record<string, any>> {
  /**
   * Run this middleware even when one before it in the chain refused the
   * request, so the headers it sets reach the refusal (a `body-limit` 413, a
   * `rate-limit` 429, an `auth` 401). `CorsMiddleware` sets it, and so should
   * an app's own middleware that only adds response headers such as CORS.
   *
   * Such a middleware must not refuse, read the body, or rely on what the
   * middleware before it returned: after a refusal it runs on a request that
   * will not reach the handler. One that throws then is logged and ignored.
   */
  static runsOnRefusal = false;

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
