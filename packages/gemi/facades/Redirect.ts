import type { UrlParser, ViewPaths } from "../client/types";
import { RequestBreakerError } from "../http/Error";
import { applyParams } from "../utils/applyParams";

class RedirectError extends RequestBreakerError {
  constructor(path: string, status = 307) {
    super("Redirect error");
    this.name = "RedirectError";
    this.payload = {
      api: {
        status: 200,
        data: {},
        directive: { kind: "Redirect", path },
      },
      view: {
        status,
        headers: {
          "Cache-Control":
            "private, no-cache, no-store, max-age=0, must-revalidate",
          Location: path,
        },
      },
    };
  }
}

type Options<T extends ViewPaths> = UrlParser<T> extends Record<string, never>
  ? {
      search?: Record<string, string | number | boolean | undefined | null>;
      status?: number;
      permanent?: boolean;
    }
  : {
      search?: Record<string, string | number | boolean | undefined | null>;
      params: UrlParser<T>;
      status?: number;
      permanent?: boolean;
    };

export class Redirect {
  static to<T extends ViewPaths>(
    path: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? [options?: Options<T>]
      : [options: Options<T>]
  ) {
    const [options = {}] = args;
    const {
      search = {},
      params = {},
      permanent,
      status,
    } = {
      params: {},
      status: 307,
      permanent: false,
      ...options,
    };
    const searchParams = new URLSearchParams(search).toString();
    throw new RedirectError(
      [applyParams(path, params), searchParams.toString()]
        .filter(Boolean)
        .join("?"),
      status ?? (permanent ? 301 : 307),
    );
  }

  static external(url: string, status = 307) {
    throw new RedirectError(url, status);
  }
}
