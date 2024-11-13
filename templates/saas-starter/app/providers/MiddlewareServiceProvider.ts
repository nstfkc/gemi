import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  RateLimitMiddleware,
  CacheMiddleware,
} from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
  };
}
