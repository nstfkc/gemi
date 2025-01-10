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
        status: 307,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: path,
        },
      },
    };
  }
}

type Options<T extends ViewPaths> =
  UrlParser<T> extends Record<string, never>
    ? {
        search?: Record<string, string | number | boolean | undefined | null>;
      }
    : {
        search?: Record<string, string | number | boolean | undefined | null>;
        params: UrlParser<T>;
      };

export class Redirect {
  static to<T extends ViewPaths>(
    path: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? [options?: Options<T>]
      : [options: Options<T>]
  ) {
    const [options = {}] = args;
    const { search = {}, params = {} } = {
      params: {},
      ...options,
    };
    const searchParams = new URLSearchParams(search).toString();
    throw new RedirectError(
      [applyParams(path, params), searchParams.toString()]
        .filter(Boolean)
        .join("?"),
    );
  }
}
