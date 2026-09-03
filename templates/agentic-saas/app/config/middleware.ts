import {
  defineMiddlewareConfig,
  AuthenticationMiddleware,
  RateLimitMiddleware,
  CacheMiddleware,
  CSRFMiddleware,
  CorsMiddleware,
} from "gemi/http";

export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware.configure({
      origins: {
        "http://localhost:3000": {
          "Access-Control-Allow-Methods": "GET, POST",
        },
      },
    }),
  },
});
