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
