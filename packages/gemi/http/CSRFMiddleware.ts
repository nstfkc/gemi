import { RequestBreakerError } from "./Error";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";
import { createHmac, timingSafeEqual } from "crypto";

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

    try {
      const secret = Buffer.from(process.env.SECRET, "utf8");
      const mac = createHmac("sha256", secret as any);
      mac.update(csrfToken);
      const expectedHMAC = mac.digest();

      const cloneReq = this.req.rawRequest.clone();
      const httpRequest = new HttpRequest(cloneReq);
      const input = await httpRequest.input();

      const csrfTokenHMAC = Buffer.from(input.get("__csrf"), "base64");

      if (!timingSafeEqual(csrfTokenHMAC as any, expectedHMAC as any)) {
        throw new InvalidCSRFTokenError();
      }
    } catch (err) {
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
