import { KernelContext } from "../kernel/KernelContext";
import { RateLimiterServiceContainer } from "../services/rate-limiter/RateLimiterServiceContainer";
import { RequestBreakerError } from "./Error";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";

class RateLimitExceededError extends RequestBreakerError {
  constructor() {
    super("Rate limit exceeded");
    this.payload = {
      api: {
        status: 429,
        data: {
          error: {
            message: "Rate limit exceeded",
          },
        },
        headers: {
          "Content-Type": "application/json",
        },
      },
      view: {
        error: {
          message: "Rate limit exceeded",
        },
        status: 429,
      },
    };
  }
}

export class RateLimitMiddleware extends Middleware {
  async run(req: HttpRequest, limit = 1000) {
    const userId = req.headers.get("x-forwarded-for");
    const driver = RateLimiterServiceContainer.use().service.driver;
    const result = driver.consume.call(driver, userId, this.routePath);
    if (result > limit) {
      throw new RateLimitExceededError();
    }

    return {};
  }
}
