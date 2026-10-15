import { type MetaFont, type NormalizedFont, normalizeFonts } from "../client/fonts";
import { configuredAppOrigin } from "../utils/appOrigin";

export type { MetaFont };

export type OpenGraphParams = {
  title: string;
  description?: string;
  type: string;
  url: string;
  /** Rendered as `og:image` only when set. A path is prefixed with the app origin. */
  image?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  twitterImage?: string;
  twitterImageAlt?: string;
  twitterImageWidth?: number;
  twitterImageHeight?: number;
  /**
   * The `twitter:card` type. Defaults to `"summary_large_image"` when the page
   * has an image (`twitterImage ?? image`), `"summary"` otherwise.
   */
  twitterCard?: "summary" | "summary_large_image";
};
/**
 * Attributes for the document's `<html>` element, handed to the root (or a
 * static view's) layout as its `htmlAttributes` prop.
 */
export type HtmlAttributes = {
  /** The document's language, e.g. `"tr"`. Defaults to the request's locale. */
  lang?: string;
  /** Text direction. Defaults to the one `lang` is written in. */
  dir?: "ltr" | "rtl" | "auto";
};

/** One `<link rel="alternate" hreflang>`: the same page in another language. */
export type AlternateLink = {
  /** A BCP 47 tag, or `"x-default"` for the page to use when none matches. */
  hrefLang: string;
  href: string;
};

export class Metadata {
  content: any = {
    title: "Gemi App",
    description: null,
    openGraph: null,
    htmlAttributes: null,
    canonical: null,
    alternates: null,
    fonts: null,
  };

  /**
   * Whether a handler set anything, as opposed to `content` still being the
   * defaults. A partially rendered response that touched no metadata sends
   * none, so the client keeps what the skipped segments put there.
   */
  touched = false;

  render() {
    return {
      title: this.content.title,
      description: this.content.description,
      openGraph: this.content.openGraph,
      htmlAttributes: this.content.htmlAttributes,
      canonical: this.content.canonical,
      alternates: this.content.alternates,
      fonts: this.content.fonts,
    };
  }

  /** Merged into what earlier calls set; `undefined` leaves an attribute alone. */
  htmlAttributes(attributes: HtmlAttributes) {
    this.touched = true;
    const defined = Object.fromEntries(
      Object.entries(attributes).filter(([, value]) => value !== undefined),
    );
    this.content.htmlAttributes = { ...this.content.htmlAttributes, ...defined };
  }

  canonical(url: string) {
    this.touched = true;
    this.content.canonical = url;
  }

  alternates(links: AlternateLink[]) {
    this.touched = true;
    this.content.alternates = links;
  }

  /** Added to what earlier calls declared, so a layout and its page can both declare fonts. */
  fonts(fonts: MetaFont[]) {
    const normalized: NormalizedFont[] = normalizeFonts(fonts);
    this.touched = true;
    this.content.fonts = [...(this.content.fonts ?? []), ...normalized];
  }

  title(title: string) {
    this.touched = true;
    this.content.title = title;
  }

  description(description: string) {
    this.touched = true;
    this.content.description = description;
  }

  openGraph({
    title,
    description,
    type,
    url,
    image,
    imageAlt,
    imageWidth,
    imageHeight,
    twitterImage = image,
    twitterImageAlt = imageAlt,
    twitterImageWidth = imageWidth,
    twitterImageHeight = imageHeight,
    twitterCard = twitterImage ? "summary_large_image" : "summary",
  }: OpenGraphParams) {
    this.touched = true;
    const absolute = (src: string | undefined) =>
      src && !src.startsWith("http") ? `${configuredAppOrigin()}${src}` : src;
    this.content.openGraph = Object.fromEntries(
      Object.entries({
        title,
        description,
        type,
        url,
        image: absolute(image),
        imageAlt,
        imageWidth,
        imageHeight,
        twitterImage: absolute(twitterImage),
        twitterImageAlt,
        twitterImageWidth,
        twitterImageHeight,
        twitterCard,
      }).filter(([_, value]) => value !== undefined),
    );
  }
}
