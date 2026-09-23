import type { UrlParser, ViewPaths } from "../client/types";
import { app } from "../foundation/app";
import { RequestContext } from "../http/requestContext";
import { DomainRouter } from "../services/router/DomainRouter";
import { applyParams } from "../utils/applyParams";
import { domainUrl, type DomainTarget } from "../utils/domainUrl";

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

  /**
   * An absolute URL on another `route.domains` host:
   * `Url.forDomain({ subdomain: "acme" }, "/projects/:id", { id })`. Inside a
   * request the protocol and port are the request's own; outside one — a job,
   * an email — they come from `HOST_NAME`.
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
    const origin = raw ? resolver.publicOrigin(raw) : process.env.HOST_NAME;
    if (!origin) {
      throw new Error("`Url.forDomain` outside a request needs `HOST_NAME` for the protocol.");
    }
    return domainUrl(
      { root: resolver.root, origin },
      target,
      applyParams(String(key), args[0] ?? {}),
    );
  }
}
