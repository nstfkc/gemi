import type { UrlParser, ViewPaths } from "../client/types";
import { app } from "../foundation/app";
import { RequestContext } from "../http/requestContext";
import { DomainRouter } from "../services/router/DomainRouter";
import { appOrigin, configuredAppOrigin } from "../utils/appOrigin";
import { applyParams } from "../utils/applyParams";
import { domainUrl, type DomainTarget } from "../utils/domainUrl";

export class Url {
  /**
   * The app's public origin, e.g. `https://example.com`: `HOST_NAME`, else
   * `APP_URL`, trimmed and without a trailing `/`. For links that leave the
   * app (emails, payment return URLs, webhooks you register):
   * `${Url.origin()}/billing`.
   *
   * Read on every call, so `vi.stubEnv("HOST_NAME", ...)` applies at once.
   * Throws when neither variable is set and no `fallback` is given, or when
   * the value is not an absolute http(s) URL.
   */
  static origin(fallback?: string): string {
    return appOrigin(fallback);
  }

  static absolute<T extends ViewPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? []
      : [params: UrlParser<T>]
  ) {
    return `${configuredAppOrigin()}${applyParams(String(key), args[0] ?? {})}`;
  }

  static relative<T extends ViewPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? []
      : [params: UrlParser<T>]
  ) {
    return applyParams(String(key), args[0] ?? {});
  }

  /**
   * An absolute URL on another `route.domains` host:
   * `Url.forDomain({ subdomain: "acme" }, "/projects/:id", { id })`. Inside a
   * request the protocol and port are the request's own; outside one — a job,
   * an email — they come from `Url.origin()` (`HOST_NAME`, else `APP_URL`).
   */
  static forDomain<T extends ViewPaths>(
    target: DomainTarget,
    key: T,
    ...args: UrlParser<T> extends Record<string, never>
      ? []
      : [params: UrlParser<T>]
  ) {
    const resolver = app(DomainRouter).resolver;
    if (!resolver) {
      throw new Error("`Url.forDomain` needs `route.domains` to be configured.");
    }
    const raw = RequestContext.getStore()?.req?.rawRequest;
    const origin = raw ? resolver.publicOrigin(raw) : configuredAppOrigin();
    if (!origin) {
      throw new Error("`Url.forDomain` outside a request needs `HOST_NAME` (or `APP_URL`) for the protocol.");
    }
    return domainUrl(
      { root: resolver.root, origin },
      target,
      applyParams(String(key), args[0] ?? {}),
    );
  }
}
