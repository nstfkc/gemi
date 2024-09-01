import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  RateLimitMiddleware,
} from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    "rate-limit": RateLimitMiddleware,
  };
}
