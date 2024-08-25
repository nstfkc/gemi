import type { UrlParser, ViewPaths } from "../client/types";
import { RequestBreakerError } from "../http/Error";
import { applyParams } from "../utils/applyParams";

class RedirectError extends RequestBreakerError {
  constructor(path: string) {
    super("Redirect error");
    this.name = "RedirectError";
    this.payload = {
      api: {
        status: 200,
        data: {},
        directive: { kind: "Redirect", path },
      },
      view: {
        status: 302,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: path,
        },
      },
    };
  }
}

export class Redirect {
  static to<T extends ViewPaths>(
    path: T,
    ...args: UrlParser<`${T & string}`> extends Record<string, never>
      ? []
      : [params: UrlParser<`${T & string}`>]
  ) {
    const [params = {}] = args;
    throw new RedirectError(applyParams(path, params));
  }
}
