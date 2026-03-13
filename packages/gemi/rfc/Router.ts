// @ts-nocheck
class ApiRouter {
  #routes = {};

  static routes(routes: any) {}
  static post() {}
}

class Middleware {
  run() {}
  static pipe(...args: any[]) {
    return {
      next: (fn: any) => {},
    };
  }
}

class CSRFMiddleware {
  run() {}
  static next(fn: any) {}
}

class CacheMiddleware {
  run() {}
  static next(fn: any) {}
}

class AuthMiddleware {
  run() {}
  static next(fn: any) {}
}

ApiRouter.routes(
  AuthMiddleware.next({
    "POST::/": CSRFMiddleware.next(HomeController.use("index")),
    "RESOURCE::/products/:productId": () => {},
    "GET::/products/:productId": Middleware.pipe(CacheMiddleware).next(
      () => {},
    ),
  }),
);

export default ApiRouter.path("/api")
  .middleware(Auth)
  .add(Controller.post("/test", "handler").middleware(Auth.ignore()))
  .add(Controller.post("/test", "handler"))
  .add(ApiRouter.post((req) => req.cookies()));

export default ApiRouter.path("/api")
  .middleware(Auth, Cache.configure("private"))
  .POST("/path", Controller.use("handler"))
  .GET("/path", Controller.use("handler"));

export default class extends ApiRouter {
  routes = {
    "/": HomeController.get("index"),
    "/products/:productId": ProductController.resource(),
    "/test": [
      TestController.get("test").middleware(Auth.ignore()),
      TestController.post("test").middleware(Auth),
    ],
  };
}
