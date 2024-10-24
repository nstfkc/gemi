import type { UrlParser, ViewPaths } from "../client/types";
import { applyParams } from "../utils/applyParams";

export class Url {
  static absolute<T extends ViewPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? []
      : [params: UrlParser<T>]
  ) {
    return `${process.env.HOST_NAME}${applyParams(String(key), args[0] ?? {})}`;
  }

  static relative<T extends ViewPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? []
      : [params: UrlParser<T>]
  ) {
    return applyParams(String(key), args[0] ?? {});
  }
}
