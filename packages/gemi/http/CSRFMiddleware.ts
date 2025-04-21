import { RequestBreakerError } from "./Error";
import { Middleware } from "./Middleware";

export class CSRFMiddleware extends Middleware {
  async run() {
    const csrfToken = this.req.cookies.get("csrf_token");
    if (!csrfToken) {
      throw new InvalidCSRFTokenError();
    }
    const NON_GET_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
    if (!NON_GET_METHODS.includes(this.req.rawRequest.method)) {
      return {};
    }

    if (!Bun.CSRF.verify(csrfToken, { secret: process.env.SECRET })) {
      throw new InvalidCSRFTokenError();
    }

    return {};
  }
}

export class InvalidCSRFTokenError extends RequestBreakerError {
  constructor() {
    super("Invalid CSRF token");
    this.name = "InvalidCSRFTokenError";
  }

  payload = {
    api: {
      status: 403,
      data: { error: "Invalid CSRF token" },
    },
    view: {},
  };
}
