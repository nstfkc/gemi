import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  RateLimitMiddleware,
  CacheMiddleware,
  CSRFMiddleware,
} from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
  };
}
