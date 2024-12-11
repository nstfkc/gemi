import { AuthApiRouter } from "../../auth/AuthenticationServiceProvider";
import { HttpRequest } from "../../http";
import { GEMI_REQUEST_BREAKER_ERROR } from "../../http/Error";
import { I18nRouter } from "../../http/I18nServiceContainer";
import { RequestContext } from "../../http/requestContext";
import { ImageOptimizationRouter } from "../image-optimization/ImageOptimizationServiceContainer";
import { LoggingRouter } from "../logging/LoggingRouter";
import { MiddlewareServiceContainer } from "../middleware/MiddlewareServiceContainer";
import { ServiceContainer } from "../ServiceContainer";
import { ApiRouterServiceProvider } from "./ApiRouterServiceProvider";
import { createFlatApiRoutes, type FlatApiRoutes } from "./createFlatApiRoutes";

export class ApiRouterServiceContainer extends ServiceContainer {
  static _name = "ApiRouterServiceContainer";

  flatRoutes: FlatApiRoutes = {};

  constructor(public service: ApiRouterServiceProvider) {
    super();
    this.flatRoutes = createFlatApiRoutes({
      "/": this.service.rootRouter.bind(this.service),
      "/auth": AuthApiRouter,
      "/__gemi__/services/i18n": I18nRouter,
      "/__gemi__/services/logs": LoggingRouter,
      "/__gemi__/services/image": ImageOptimizationRouter,
    });
  }

  public getRouteHandlerAndParams(req: Request) {
    const url = new URL(req.url);

    const apiPath = url.pathname.replace("/api", "");

    let params: Record<string, any> = {};
    let path: string;
    for (const [_path] of Object.entries(this.flatRoutes)) {
      try {
        const pattern = new URLPattern({ pathname: _path });
        if (pattern.test({ pathname: apiPath })) {
          path = _path;
          params = pattern.exec({ pathname: apiPath })?.pathname.groups!;
          break;
        }
      } catch (err) {
        console.error(err);
        // Do something
      }
    }
    return { params, path };
  }

  async runRouteMiddleware(path: string, httpRequest: HttpRequest) {
    const routeHandler = this.flatRoutes[path];
    const middlewares = routeHandler[httpRequest.rawRequest.method].middleware;
    try {
      await MiddlewareServiceContainer.use().runMiddleware(middlewares);
    } catch (err) {
      if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
        if (httpRequest.rawRequest.url.includes("/api")) {
          const { status = 400, data, headers } = err.payload.api;
          return new Response(JSON.stringify(data), {
            status,
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
          });
        }
      } else {
        this.service.onRequestFail(httpRequest, err);
        console.error(err);
        throw err;
      }
    }
  }

  async getRouteData(path: string): Promise<any> {
    const routeHandler = this.flatRoutes[path];

    const ctx = RequestContext.getStore();
    const exec =
      routeHandler[ctx.req.rawRequest.method].exec ??
      (() => Promise.resolve({}));

    let data = {};
    try {
      data = await exec();
    } catch (err) {
      if (err.kind === GEMI_REQUEST_BREAKER_ERROR) {
        const { status = 400, data, headers } = err.payload.api;

        return new Response(JSON.stringify(data), {
          status,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        });
      } else {
        this.service.onRequestFail(ctx.req, err);
        console.error(err);
        throw err;
      }
    }

    return data;
  }

  async handleApiRequest(req: Request) {
    const { params, path } = this.getRouteHandlerAndParams(req);

    const routeHandler = this.flatRoutes[path];

    if (!routeHandler || !routeHandler[req.method]) {
      return new Response(JSON.stringify({ error: { message: "Not found" } }), {
        status: 404,
      });
    }

    const httpRequest = new HttpRequest(req, params, "api", path);
    if (!req.url.includes("/__gemi__")) {
      this.service.onRequestStart(httpRequest);
    }
    return await RequestContext.run(httpRequest, async () => {
      const ctx = RequestContext.getStore();
      ctx.setRequest(httpRequest);
      const middlewareResponse = await this.runRouteMiddleware(
        path,
        httpRequest,
      );

      if (middlewareResponse instanceof Response) {
        return middlewareResponse;
      }
      const data = await this.getRouteData(path);

      if (data instanceof Response) {
        return data;
      }

      const headers = ctx.headers;

      headers.append("Content-Type", "application/json");

      ctx.cookies.forEach((cookie) =>
        headers.append("Set-Cookie", cookie.toString()),
      );

      ctx.destroy();

      if (!req.url.includes("/__gemi__")) {
        this.service.onRequestEnd(httpRequest);
      }
      return new Response(JSON.stringify(data), {
        headers,
      });
    });
  }
}
