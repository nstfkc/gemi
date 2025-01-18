import { Middleware } from "./Middleware";

type CorsHeaders = {
  "Access-Control-Allow-Methods": string;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Credentials": string;
};

const defaultHeaders: CorsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Credentials": "true",
};

export class CorsMiddleware extends Middleware {
  config = {
    origins: {
      "": {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
      },
    } as Record<string, Partial<CorsHeaders>>,
  };
  run() {
    const req = this.req;
    const origin = req.rawRequest.headers.get("Origin");
    if (this.config.origins[origin]) {
      req.ctx().setHeaders("Access-Control-Allow-Origin", origin);
      const headers = { ...defaultHeaders, ...this.config.origins[origin] };

      for (const [key, value] of Object.entries(headers)) {
        req.ctx().setHeaders(key, value);
      }
    }

    return {};
  }
}
