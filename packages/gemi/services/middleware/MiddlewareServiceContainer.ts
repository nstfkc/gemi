import { HttpRequest, Middleware, MiddlewareServiceProvider } from "../../http";
import { RequestContext } from "../../http/requestContext";
import type { RouterMiddleware } from "../../http/Router";
import { isConstructor } from "../../internal/isConstructor";

export class MiddlewareServiceContainer {
  constructor(public service: MiddlewareServiceProvider) {}

  public runMiddleware(
    middleware: (string | RouterMiddleware | (new () => Middleware))[],
  ) {
    const req = RequestContext.getStore().req;

    return middleware
      .map((aliasOrTest) => {
        if (typeof aliasOrTest === "string") {
          const alias = aliasOrTest;
          const Middleware = this.service.aliases[alias];
          if (Middleware) {
            const middleware = new Middleware();
            return middleware.run;
          }
        } else {
          if (isConstructor(aliasOrTest)) {
            // TODO: fix type
            // @ts-ignore
            const middleware = new aliasOrTest();
            return middleware.run;
          }
          return aliasOrTest;
        }
      })
      .filter(Boolean)
      .reduce(
        (acc: any, middleware: any) => {
          return async (req: HttpRequest<any, any>, ctx: any) => {
            return {
              ...(await acc(req, ctx)),
              ...(await middleware(req, ctx)),
            };
          };
        },
        (_req: HttpRequest<any, any>) => Promise.resolve({}),
      )(req);
  }
}
