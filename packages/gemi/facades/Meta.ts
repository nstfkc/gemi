import type { AlternateLink, HtmlAttributes, MetaFont, OpenGraphParams } from "../http/Metadata";
import { RequestContext } from "../http/requestContext";

export class Meta {
  protected name = "Meta";
  static description(description: string) {
    RequestContext.getStore().metadata.description(description);
  }
  static title(title: string) {
    RequestContext.getStore().metadata.title(title);
  }
  static openGraph(params: OpenGraphParams) {
    RequestContext.getStore().metadata.openGraph(params);
  }
  /**
   * Attributes for this response's `<html>` element (`lang`, `dir`), e.g. a
   * page whose language is its content's rather than the visitor's. The
   * layout receives them as `htmlAttributes`; spread it onto `<html>`.
   */
  static htmlAttributes(attributes: HtmlAttributes) {
    RequestContext.getStore().metadata.htmlAttributes(attributes);
  }
  /** `<link rel="canonical">`, rendered by `<Head />`. */
  static canonical(url: string) {
    RequestContext.getStore().metadata.canonical(url);
  }
  /** `<link rel="alternate" hreflang>` for each language this page exists in, rendered by `<Head />`. */
  static alternates(links: AlternateLink[]) {
    RequestContext.getStore().metadata.alternates(links);
  }
  /**
   * `<meta name="robots">` for this response, rendered by `<Head />`, e.g.
   * `Meta.robots("noindex, nofollow")` for a page that is reached by a link
   * but must not be indexed. Pair it with an `X-Robots-Tag` header
   * (`req.ctx().setHeaders`) for crawlers that read headers only.
   */
  static robots(content: string) {
    RequestContext.getStore().metadata.robots(content);
  }
  /**
   * `@font-face` rules for this response, and a `<link rel="preload" as="font">`
   * for each font marked `preload`; `<Head />` renders both. Calls add up.
   * Throws a `TypeError` for a descriptor that isn't a valid CSS value.
   */
  static fonts(fonts: MetaFont[]) {
    RequestContext.getStore().metadata.fonts(fonts);
  }
}
