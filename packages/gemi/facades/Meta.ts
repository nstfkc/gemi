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
   * Lets browsers and Google Search translate this page (#1087): `<Head />`
   * leaves out `<meta name="google" content="notranslate">`, which it renders
   * by default. For public content (a storefront, a published site), usually
   * a static view. `false` keeps the tag where `route.view.translate` dropped
   * it. On a hydrated page a translator can rewrite the text before React
   * hydrates, which React rejects as a hydration mismatch. A
   * `<html translate="no">` in the layout still blocks translation.
   */
  static translate(allow = true) {
    RequestContext.getStore().metadata.translate(allow);
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
