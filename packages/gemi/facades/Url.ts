import type { ApiPaths, UrlParser, ViewPaths } from "../client/types";
import { app } from "../foundation/app";
import { RequestContext } from "../http/requestContext";
import { DomainRouter } from "../services/router/DomainRouter";
import { appOrigin, configuredAppOrigin } from "../utils/appOrigin";
import { apiUrl, matchApiUrl } from "../utils/apiUrl";
import { applyParams } from "../utils/applyParams";
import { domainUrl, type DomainTarget } from "../utils/domainUrl";

/** `UrlParser<T>` with every value a string, as a matched URL gives them. */
type MatchedParams<T extends string> = { [K in keyof UrlParser<T>]: string };

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
    ...args: UrlParser<T> extends Record<string, never> ? [] : [params: UrlParser<T>]
  ) {
    return `${configuredAppOrigin()}${applyParams(String(key), args[0] ?? {})}`;
  }

  static relative<T extends ViewPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never> ? [] : [params: UrlParser<T>]
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
    ...args: UrlParser<T> extends Record<string, never> ? [] : [params: UrlParser<T>]
  ) {
    const resolver = app(DomainRouter).resolver;
    if (!resolver) {
      throw new Error("`Url.forDomain` needs `route.domains` to be configured.");
    }
    const raw = RequestContext.getStore()?.req?.rawRequest;
    const origin = raw ? resolver.publicOrigin(raw) : configuredAppOrigin();
    if (!origin) {
      throw new Error(
        "`Url.forDomain` outside a request needs `HOST_NAME` (or `APP_URL`) for the protocol.",
      );
    }
    return domainUrl(
      { root: resolver.root, origin },
      target,
      applyParams(String(key), args[0] ?? {}),
    );
  }

  /**
   * The URL of an api route, from its path in the app's `ApiRouter`, under
   * `/api`: `Url.api("/pages/:pageId/files/:fileId", { pageId, fileId })` is
   * `/api/pages/p1/files/f1`. The path is typed from the app's routes and the
   * params from the path, so renaming a route is a type error here.
   *
   * Each param is `encodeURIComponent`-ed. A required param left out throws.
   */
  static api<T extends ApiPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never> ? [] : [params: UrlParser<T>]
  ): string {
    return apiUrl(String(key), (args[0] ?? {}) as Record<string, string>);
  }

  /**
   * `Url.api` on the app's public origin (`Url.origin()`):
   * `https://example.com/api/designer-files/f1`. Throws when neither
   * `HOST_NAME` nor `APP_URL` is set.
   */
  static apiAbsolute<T extends ApiPaths>(
    key: T,
    ...args: UrlParser<T> extends Record<string, never> ? [] : [params: UrlParser<T>]
  ): string {
    return `${appOrigin()}${apiUrl(String(key), (args[0] ?? {}) as Record<string, string>)}`;
  }

  /**
   * The params of `url` when it is the URL of the api route `key`, decoded,
   * or `null`: `Url.matchApi("/pages/:pageId/files/:fileId",
   * "/api/pages/p1/files/f1")` is `{ pageId: "p1", fileId: "f1" }`. `url` may
   * be a path or absolute (any host); its query and hash are ignored. The
   * inverse of `Url.api`.
   */
  static matchApi<T extends ApiPaths>(key: T, url: string): MatchedParams<T> | null {
    return matchApiUrl(String(key), url) as MatchedParams<T> | null;
  }
}
