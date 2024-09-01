import { KernelContext } from "../kernel/KernelContext";
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
        status: 429,
      },
    };
  }
}

export class RateLimitMiddleware extends Middleware {
  async run(req: HttpRequest) {
    const userId = req.headers.get("x-forwarded-for");
    const driver =
      KernelContext.getStore().rateLimiterServiceContainer.service.driver;
    const result = driver.consume.call(driver, userId, this.routePath);
    if (result > 10) {
      throw new RateLimitExceededError();
    }

    return {};
  }
}
