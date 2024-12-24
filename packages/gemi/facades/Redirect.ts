import type { UrlParser, ViewPaths } from "../client/types";
import { RequestBreakerError } from "../http/Error";
import { applyParams } from "../utils/applyParams";

class RedirectError extends RequestBreakerError {
  constructor(path: string, headers: Record<string, string> = {}) {
    super("Redirect error");
    this.name = "RedirectError";
    this.payload = {
      api: {
        status: 200,
        data: {},
        directive: { kind: "Redirect", path },
      },
      view: {
        status: 307,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: path,
          ...headers,
        },
      },
    };
  }
}

export class Redirect {
  static to<T extends ViewPaths>(
    path: T,
    ...args: UrlParser<`${T & string}`> extends Record<string, never>
      ? [params: undefined, headers?: Record<string, string>]
      : [params: UrlParser<`${T & string}`>, headers?: Record<string, string>]
  ) {
    const [params = {}, headers = {}] = args;
    throw new RedirectError(applyParams(path, params), headers);
  }
}
