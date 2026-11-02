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
  /** `og:site_name`, rendered only when set. */
  siteName?: string;
  /** `twitter:title`, rendered only when set (it does not follow `title`). */
  twitterTitle?: string;
  /** `twitter:description`, rendered only when set (it does not follow `description`). */
  twitterDescription?: string;
  twitterImage?: string;
  /** Defaults to `imageAlt`; `null` leaves `twitter:image:alt` out. */
  twitterImageAlt?: string | null;
  /** Defaults to `imageWidth`; `null` leaves `twitter:image:width` out. */
  twitterImageWidth?: number | null;
  /** Defaults to `imageHeight`; `null` leaves `twitter:image:height` out. */
  twitterImageHeight?: number | null;
  /**
   * The `twitter:card` type. Defaults to `"summary_large_image"` when the page
   * has an image (`twitterImage ?? image`), `"summary"` otherwise.
   */
  twitterCard?: "summary" | "summary_large_image";
};
/**
 * The app-wide default title and metadata (`route.view.meta`, #1042): used for
 * each field that no handler (or `onNotFound`) set. See `ViewRouteConfig.meta`.
 */
export type DefaultViewMeta = {
  title?: string;
  description?: string;
  /**
   * Every field is optional: `title` and `description` default to the page's
   * own, `type` to `"website"`. `url` is left out of the page unless given.
   */
  openGraph?: Partial<OpenGraphParams>;
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

/**
 * A `<link rel="alternate" type>` without `hreflang`: the same page in another
 * format, e.g. `{ type: "text/markdown", href: "/docs/intro.md" }`.
 */
export type TypedAlternateLink = {
  /** The linked document's media type. */
  type: string;
  href: string;
};

/** What `Meta.alternates` takes: a language alternate, or one in another format. */
export type MetaAlternate = AlternateLink | TypedAlternateLink;

/**
 * One `<meta>` that `Meta.tags` adds: `name` (e.g. a site-verification token,
 * `{ name: "google-site-verification", content }`) or `property`.
 */
export type MetaTag =
  | { name: string; property?: never; content: string }
  | { property: string; name?: never; content: string };

export class Metadata {
  content: any = {
    title: "Gemi App",
    description: null,
    openGraph: null,
    htmlAttributes: null,
    canonical: null,
    alternates: null,
    fonts: null,
    robots: null,
    translate: null,
    tags: null,
  };

  /**
   * Whether a handler set anything, as opposed to `content` still being the
   * defaults. A partially rendered response that touched no metadata sends
   * none, so the client keeps what the skipped segments put there.
   */
  touched = false;

  /** The fields a handler set, which the app's default (`route.view.meta`) leaves alone. */
  private setFields = new Set<keyof DefaultViewMeta>();

  render() {
    return {
      title: this.content.title,
      description: this.content.description,
      openGraph: this.content.openGraph,
      htmlAttributes: this.content.htmlAttributes,
      canonical: this.content.canonical,
      alternates: this.content.alternates,
      fonts: this.content.fonts,
      robots: this.content.robots,
      translate: this.content.translate,
      tags: this.content.tags,
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

  /** `<meta name="robots">`'s content, e.g. `"noindex, nofollow"`; the last call wins. */
  robots(content: string) {
    this.touched = true;
    this.content.robots = content;
  }

  /**
   * Whether browsers and Google Search may translate the page (#1087). `true`
   * leaves `<meta name="google" content="notranslate">` out; `false` (or no
   * call) keeps it. The last call wins.
   */
  translate(allow = true) {
    this.touched = true;
    this.translateSet = true;
    this.content.translate = allow;
  }

  /** Whether a handler called `translate`, which the views' default (`route.view.translate`) leaves alone. */
  private translateSet = false;

  /**
   * The views' default (`route.view.translate`, #1087), for a response whose
   * handlers didn't call `translate`. Not a handler call, so `touched` stays
   * as it was.
   */
  applyTranslateDefault(allow: boolean) {
    if (!this.translateSet) {
      this.content.translate = allow;
    }
  }

  alternates(links: MetaAlternate[]) {
    this.touched = true;
    this.content.alternates = links;
  }

  /** Added to what earlier calls set, so a layout and its page can both add tags. */
  tags(tags: MetaTag[]) {
    const normalized = tags.map((tag) => {
      const key = tag.name !== undefined ? "name" : "property";
      const value = tag.name ?? tag.property;
      if (typeof value !== "string" || value === "" || (tag.name !== undefined && tag.property !== undefined)) {
        throw new TypeError("Meta.tags: each tag needs either a `name` or a `property`.");
      }
      if (typeof tag.content !== "string") {
        throw new TypeError(`Meta.tags: the tag ${value} has no string \`content\`.`);
      }
      return { [key]: value, content: tag.content } as MetaTag;
    });
    this.touched = true;
    this.content.tags = [...(this.content.tags ?? []), ...normalized];
  }

  /** Added to what earlier calls declared, so a layout and its page can both declare fonts. */
  fonts(fonts: MetaFont[]) {
    const normalized: NormalizedFont[] = normalizeFonts(fonts);
    this.touched = true;
    this.content.fonts = [...(this.content.fonts ?? []), ...normalized];
  }

  title(title: string) {
    this.touched = true;
    this.setFields.add("title");
    this.content.title = title;
  }

  description(description: string) {
    this.touched = true;
    this.setFields.add("description");
    this.content.description = description;
  }

  /** Whether every field the app's default could fill was set by a handler. */
  get hasAllDefaultFields() {
    return this.setFields.size === 3;
  }

  /**
   * Fills each of `title`, `description` and `openGraph` that no handler set
   * from the app's default (`route.view.meta`, #1042). Field by field: a
   * handler's `Meta.title` keeps its title and still gets the default
   * description. Not a handler call, so `touched` stays as it was.
   *
   * The default's Open Graph fields fall back to the page's title and
   * description and to `type: "website"`; `url` is only rendered when given.
   */
  applyDefaults(defaults: DefaultViewMeta) {
    if (!this.setFields.has("title") && defaults.title !== undefined) {
      this.content.title = defaults.title;
    }
    if (!this.setFields.has("description") && defaults.description !== undefined) {
      this.content.description = defaults.description;
    }
    if (!this.setFields.has("openGraph") && defaults.openGraph) {
      const { title, description, type, ...rest } = defaults.openGraph;
      this.content.openGraph = this.normalizeOpenGraph({
        ...rest,
        title: title ?? this.content.title,
        description: description ?? this.content.description ?? undefined,
        type: type ?? "website",
      });
    }
  }

  openGraph(params: OpenGraphParams) {
    this.touched = true;
    this.setFields.add("openGraph");
    this.content.openGraph = this.normalizeOpenGraph(params);
  }

  private normalizeOpenGraph({
    title,
    description,
    type,
    url,
    image,
    imageAlt,
    imageWidth,
    imageHeight,
    siteName,
    twitterTitle,
    twitterDescription,
    twitterImage = image,
    twitterImageAlt = imageAlt,
    twitterImageWidth = imageWidth,
    twitterImageHeight = imageHeight,
    twitterCard = twitterImage ? "summary_large_image" : "summary",
  }: Omit<OpenGraphParams, "url"> & { url?: string }) {
    const absolute = (src: string | undefined) =>
      src && !src.startsWith("http") ? `${configuredAppOrigin()}${src}` : src;
    return Object.fromEntries(
      Object.entries({
        title,
        description,
        type,
        url,
        image: absolute(image),
        imageAlt,
        imageWidth,
        imageHeight,
        siteName,
        twitterTitle,
        twitterDescription,
        twitterImage: absolute(twitterImage),
        twitterImageAlt,
        twitterImageWidth,
        twitterImageHeight,
        twitterCard,
      })
        // `null` (a twitter image field turned off) is left out like `undefined`.
        .filter(([_, value]) => value !== undefined && value !== null),
    );
  }
}
