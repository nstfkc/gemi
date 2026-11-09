import type { MetaAlternate, MetaTag } from "../http/Metadata";
import { type ReactNode, useContext } from "react";
import { ServerDataContext } from "./ServerDataProvider";
import { resolveHtmlAttributes } from "./htmlAttributes";
import { fontFaceRules, fontPreloads } from "./fonts";
import { applyDocumentNonce, useCspNonce } from "./cspNonce";

/**
 * Marks the `<link>`s, `<meta name="robots">` and `Meta.tags` rendered from
 * metadata, so a navigation can replace them.
 */
const GEMI_META_ATTRIBUTE = "data-gemi-meta";

type MetaLink = { rel: "canonical" | "alternate"; href: string; hrefLang?: string; type?: string };

function metaLinks(
  canonical: string | null | undefined,
  alternates: MetaAlternate[] | null | undefined,
): MetaLink[] {
  const links: MetaLink[] = [];
  if (canonical) links.push({ rel: "canonical", href: canonical });
  for (const alternate of alternates ?? []) {
    links.push({
      rel: "alternate",
      href: alternate.href,
      hrefLang: "hrefLang" in alternate ? alternate.hrefLang : undefined,
      type: "type" in alternate ? alternate.type : undefined,
    });
  }
  return links;
}

/** The attribute (`name` or `property`) and its value of a `Meta.tags` entry. */
function tagKey(tag: MetaTag): ["name" | "property", string] {
  return tag.name !== undefined ? ["name", tag.name] : ["property", tag.property as string];
}

/** Marks the `<style>`s holding `Meta.fonts`' `@font-face` rules. */
const GEMI_FONTS_ATTRIBUTE = "data-gemi-fonts";

/**
 * The `@font-face` rules already in the document. A navigation adds the new
 * page's and removes none: a skipped layout's fonts are still in use, and an
 * unused `@font-face` costs nothing (it is only fetched when text uses it).
 */
const appliedFontRules = new Set<string>();

/** The `notranslate` tag `<Head />` renders, which `Meta.translate` leaves out (#1087). */
const NOTRANSLATE_SELECTOR = 'meta[name="google"][content="notranslate"]';

/** Whether a navigation removed `<Head />`'s `notranslate` tag, to put it back on a page that keeps it. */
let notranslateRemoved = false;

/** Whether a navigation has set `<html>` attributes from metadata. */
let htmlAttributesApplied = false;

export function updateMeta(meta: any, locale?: string | null) {
  // A partially rendered response whose segments set no metadata sends none —
  // what is on the page belongs to the segments that were skipped.
  if (!meta) {
    return;
  }
  const { title, description, htmlAttributes, canonical, alternates, fonts, robots, translate, tags } = meta;
  // A page that allows translation drops the tag; the next page that doesn't
  // gets it back. Only the tag gemi removed is put back.
  if (translate === true) {
    const notranslate = document.head.querySelector(NOTRANSLATE_SELECTOR);
    if (notranslate) {
      notranslate.remove();
      notranslateRemoved = true;
    }
  } else if (notranslateRemoved) {
    const element = document.createElement("meta");
    element.setAttribute("name", "google");
    element.setAttribute("content", "notranslate");
    document.head.appendChild(element);
    notranslateRemoved = false;
  }
  // A page that set `<html>` attributes gets them; after one, a page that set
  // none goes back to its locale's. A layout that never asked keeps its own.
  if (htmlAttributes || htmlAttributesApplied) {
    htmlAttributesApplied = true;
    for (const [name, value] of Object.entries(resolveHtmlAttributes(htmlAttributes, locale))) {
      if (typeof value === "string") {
        document.documentElement.setAttribute(name, value);
      }
    }
  }
  // The links and robots tag `<Head />` rendered from metadata, and only
  // those: a layout's own `<link>`s and `<meta>`s are left alone.
  document.head
    .querySelectorAll(`link[${GEMI_META_ATTRIBUTE}], meta[${GEMI_META_ATTRIBUTE}]`)
    .forEach((element) => element.remove());
  if (robots) {
    const element = document.createElement("meta");
    element.setAttribute("name", "robots");
    element.setAttribute("content", robots);
    element.setAttribute(GEMI_META_ATTRIBUTE, "");
    document.head.appendChild(element);
  }
  for (const tag of (tags ?? []) as MetaTag[]) {
    const [key, value] = tagKey(tag);
    const element = document.createElement("meta");
    element.setAttribute(key, value);
    element.setAttribute("content", tag.content);
    element.setAttribute(GEMI_META_ATTRIBUTE, "");
    document.head.appendChild(element);
  }
  for (const link of metaLinks(canonical, alternates)) {
    const element = document.createElement("link");
    element.setAttribute("rel", link.rel);
    element.setAttribute("href", link.href);
    if (link.hrefLang) element.setAttribute("hreflang", link.hrefLang);
    if (link.type) element.setAttribute("type", link.type);
    element.setAttribute(GEMI_META_ATTRIBUTE, "");
    document.head.appendChild(element);
  }
  const newFontRules = fontFaceRules(fonts).filter((rule) => !appliedFontRules.has(rule));
  if (newFontRules.length > 0) {
    const style = document.createElement("style");
    style.setAttribute(GEMI_FONTS_ATTRIBUTE, "");
    applyDocumentNonce(style);
    style.textContent = newFontRules.join("\n");
    document.head.appendChild(style);
    for (const rule of newFontRules) appliedFontRules.add(rule);
  }
  if (title) {
    document.title = title;
  }
  if (description) {
    const desc = document.querySelector("meta[name='description']");
    if (desc) {
      desc.setAttribute("content", description);
    } else {
      const newDesc = document.createElement("meta");
      newDesc.setAttribute("name", "description");
      newDesc.setAttribute("content", description);
      document.head.appendChild(newDesc);
    }
  }
}

const OpenGraph = (props: {
  title: string;
  type: string;
  url?: string;
  image?: string;
  description?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  twitterImageAlt?: string;
  twitterImageWidth?: number;
  twitterImageHeight?: number;
  twitterCard?: "summary" | "summary_large_image";
}) => {
  const {
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
    twitterImage,
    twitterImageAlt,
    twitterImageWidth,
    twitterImageHeight,
    // `Metadata.openGraph` always sets it.
    twitterCard = twitterImage ? "summary_large_image" : "summary",
  } = props;

  return (
    <>
      <meta property="og:title" content={title} />
      <meta property="og:type" content={type} />
      {url && <meta property="og:url" content={url} />}
      {image && <meta property="og:image" content={image} />}
      {description && <meta property="og:description" content={description} />}
      {imageAlt && <meta property="og:image:alt" content={imageAlt} />}
      {imageWidth && (
        <meta property="og:image:width" content={String(imageWidth)} />
      )}
      {imageHeight && (
        <meta property="og:image:height" content={String(imageHeight)} />
      )}
      {siteName && <meta property="og:site_name" content={siteName} />}
      {twitterImage && <meta name="twitter:image" content={twitterImage} />}
      <meta name="twitter:card" content={twitterCard} />
      {twitterTitle && <meta name="twitter:title" content={twitterTitle} />}
      {twitterDescription && (
        <meta name="twitter:description" content={twitterDescription} />
      )}
      {twitterImageAlt && (
        <meta name="twitter:image:alt" content={twitterImageAlt} />
      )}
      {twitterImageWidth && (
        <meta name="twitter:image:width" content={String(twitterImageWidth)} />
      )}
      {twitterImageHeight && (
        <meta
          name="twitter:image:height"
          content={String(twitterImageHeight)}
        />
      )}
    </>
  );
};

/**
 * Keys `<Head viewport>` adds to `width=device-width, initial-scale=1` (#1172).
 * Zoom-limiting keys (`maximum-scale`, `user-scalable`) are left out on
 * purpose: pinch zoom stays allowed.
 */
export interface HeadViewport {
  /** `viewport-fit`. `"cover"` lets the page draw under the notch and the
   *  home indicator, and is what makes `env(safe-area-inset-*)` non-zero. */
  fit?: "auto" | "contain" | "cover";
  /** `interactive-widget`: what the on-screen keyboard resizes. */
  interactiveWidget?: "resizes-visual" | "resizes-content" | "overlays-content";
}

/** One `<meta name="theme-color">`, optionally for one `media` query. */
export interface HeadThemeColor {
  color: string;
  /** e.g. `"(prefers-color-scheme: dark)"`. */
  media?: string;
}

function viewportContent(viewport: HeadViewport | undefined): string {
  const keys = ["width=device-width", "initial-scale=1"];
  if (viewport?.fit) keys.push(`viewport-fit=${viewport.fit}`);
  if (viewport?.interactiveWidget) keys.push(`interactive-widget=${viewport.interactiveWidget}`);
  return keys.join(", ");
}

function themeColors(themeColor: string | readonly HeadThemeColor[] | undefined): HeadThemeColor[] {
  if (themeColor === undefined) return [];
  return typeof themeColor === "string" ? [{ color: themeColor }] : [...themeColor];
}

export const Head = ({
  children = null,
  charSet = "utf-8",
  viewport,
  themeColor,
}: {
  children?: ReactNode;
  charSet?: string;
  /** Keys added to the viewport meta, e.g. `{ fit: "cover" }`. See `HeadViewport`. */
  viewport?: HeadViewport;
  /**
   * `<meta name="theme-color">`: one colour, or one entry per `media` query,
   * e.g. one for `(prefers-color-scheme: light)` and one for `dark`.
   */
  themeColor?: string | readonly HeadThemeColor[];
}) => {
  const { meta } = useContext(ServerDataContext);
  const nonce = useCspNonce();
  // The first page set them, so the layout rendered them: a later page that
  // sets none has to go back to its locale's (`updateMeta`). Only ever read
  // in the browser.
  if (meta?.htmlAttributes) {
    htmlAttributesApplied = true;
  }
  // The first page left the `notranslate` tag out: a later page that keeps
  // it has to get it back (`updateMeta`).
  if (meta?.translate === true && typeof window !== "undefined") {
    notranslateRemoved = true;
  }
  const fontRules = fontFaceRules(meta?.fonts);
  // Browser only: on the server the set would be shared by every request.
  if (typeof window !== "undefined") {
    for (const rule of fontRules) appliedFontRules.add(rule);
  }
  return (
    <head>
      <meta charSet={charSet} />
      <meta name="viewport" content={viewportContent(viewport)} />
      {themeColors(themeColor).map((entry, index) => (
        <meta
          key={`theme-color:${index}`}
          name="theme-color"
          content={entry.color}
          media={entry.media}
        />
      ))}
      {/*
        Disable browser auto-translation (Chrome/Google Translate). Gemi apps do
        their own i18n, and a translator that rewrites text nodes *before* React
        hydrates mutates the SSR DOM — which React rejects as a hydration
        mismatch (Minified React error #418) and then regenerates the tree,
        dropping the server-injected <style> and leaving the page unstyled.
        Pair this with `translate="no"` on the <html> element in RootLayout.
        `Meta.translate()` (or `route.view.translate`) leaves it out, for
        public content such as a static storefront (#1087).
      */}
      {meta?.translate !== true && <meta name="google" content="notranslate" />}
      <title>{meta?.title}</title>
      {meta?.description && (
        <meta name="description" content={meta.description} />
      )}
      {meta?.robots && (
        <meta name="robots" content={meta.robots} {...{ [GEMI_META_ATTRIBUTE]: "" }} />
      )}
      {meta?.openGraph && <OpenGraph {...meta.openGraph} />}
      {((meta?.tags ?? []) as MetaTag[]).map((tag, index) => {
        const [key, value] = tagKey(tag);
        return (
          <meta
            key={`${index}:${key}:${value}`}
            {...{ [key]: value }}
            content={tag.content}
            {...{ [GEMI_META_ATTRIBUTE]: "" }}
          />
        );
      })}
      {metaLinks(meta?.canonical, meta?.alternates).map((link) => (
        <link
          key={`${link.rel}:${link.hrefLang ?? ""}:${link.type ?? ""}:${link.href}`}
          rel={link.rel}
          href={link.href}
          hrefLang={link.hrefLang}
          type={link.type}
          {...{ [GEMI_META_ATTRIBUTE]: "" }}
        />
      ))}
      {fontPreloads(meta?.fonts).map((preload) => (
        <link
          key={`preload:${preload.href}`}
          rel="preload"
          as="font"
          href={preload.href}
          type={preload.type ?? undefined}
          crossOrigin=""
        />
      ))}
      {fontRules.length > 0 && (
        <style
          {...{ [GEMI_FONTS_ATTRIBUTE]: "" }}
          nonce={nonce}
          // The browser hides a nonce's value once the page loads (#1195).
          suppressHydrationWarning
          // Escaped by `fontFaceRule`: strings are CSS-escaped (`<` included),
          // descriptors are checked by `Meta.fonts`.
          dangerouslySetInnerHTML={{ __html: fontRules.join("\n") }}
        />
      )}
      {children}
    </head>
  );
};
