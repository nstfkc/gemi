import type { AlternateLink } from "../http/Metadata";
import { type ReactNode, useContext } from "react";
import { ServerDataContext } from "./ServerDataProvider";
import { resolveHtmlAttributes } from "./htmlAttributes";

/** Marks the `<link>`s rendered from metadata, so a navigation can replace them. */
const GEMI_META_ATTRIBUTE = "data-gemi-meta";

type MetaLink = { rel: "canonical" | "alternate"; href: string; hrefLang?: string };

function metaLinks(
  canonical: string | null | undefined,
  alternates: AlternateLink[] | null | undefined,
): MetaLink[] {
  const links: MetaLink[] = [];
  if (canonical) links.push({ rel: "canonical", href: canonical });
  for (const { hrefLang, href } of alternates ?? []) {
    links.push({ rel: "alternate", href, hrefLang });
  }
  return links;
}

/** Whether a navigation has set `<html>` attributes from metadata. */
let htmlAttributesApplied = false;

export function updateMeta(meta: any, locale?: string | null) {
  // A partially rendered response whose segments set no metadata sends none —
  // what is on the page belongs to the segments that were skipped.
  if (!meta) {
    return;
  }
  const { title, description, htmlAttributes, canonical, alternates } = meta;
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
  // The links `<Head />` rendered from metadata, and only those: a layout's
  // own `<link>`s are left alone.
  document.head
    .querySelectorAll(`link[${GEMI_META_ATTRIBUTE}]`)
    .forEach((link) => link.remove());
  for (const link of metaLinks(canonical, alternates)) {
    const element = document.createElement("link");
    element.setAttribute("rel", link.rel);
    element.setAttribute("href", link.href);
    if (link.hrefLang) element.setAttribute("hreflang", link.hrefLang);
    element.setAttribute(GEMI_META_ATTRIBUTE, "");
    document.head.appendChild(element);
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
  url: string;
  image: string;
  description?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  twitterImage?: string;
  twitterImageAlt?: string;
  twitterImageWidth?: number;
  twitterImageHeight?: number;
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
    twitterImage,
    twitterImageAlt,
    twitterImageWidth,
    twitterImageHeight,
  } = props;

  return (
    <>
      <meta property="og:title" content={title} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      {description && <meta property="og:description" content={description} />}
      {imageAlt && <meta property="og:image:alt" content={imageAlt} />}
      {imageWidth && (
        <meta property="og:image:width" content={String(imageWidth)} />
      )}
      {imageHeight && (
        <meta property="og:image:height" content={String(imageHeight)} />
      )}
      {twitterImage && (
        <>
          <meta name="twitter:image" content={twitterImage} />
          <meta name="twitter:card" content="summary_large_image" />
        </>
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

export const Head = ({
  children = null,
  charSet = "utf-8",
}: { children?: ReactNode; charSet?: string }) => {
  const { meta } = useContext(ServerDataContext);
  // The first page set them, so the layout rendered them: a later page that
  // sets none has to go back to its locale's (`updateMeta`). Only ever read
  // in the browser.
  if (meta?.htmlAttributes) {
    htmlAttributesApplied = true;
  }
  return (
    <head>
      <meta charSet={charSet} />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {/*
        Disable browser auto-translation (Chrome/Google Translate). Gemi apps do
        their own i18n, and a translator that rewrites text nodes *before* React
        hydrates mutates the SSR DOM — which React rejects as a hydration
        mismatch (Minified React error #418) and then regenerates the tree,
        dropping the server-injected <style> and leaving the page unstyled.
        Pair this with `translate="no"` on the <html> element in RootLayout.
      */}
      <meta name="google" content="notranslate" />
      <title>{meta?.title}</title>
      {meta?.description && (
        <meta name="description" content={meta.description} />
      )}
      {meta?.openGraph && <OpenGraph {...meta.openGraph} />}
      {metaLinks(meta?.canonical, meta?.alternates).map((link) => (
        <link
          key={`${link.rel}:${link.hrefLang ?? ""}:${link.href}`}
          rel={link.rel}
          href={link.href}
          hrefLang={link.hrefLang}
          {...{ [GEMI_META_ATTRIBUTE]: "" }}
        />
      ))}
      {children}
    </head>
  );
};
