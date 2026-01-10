import { type ReactNode, useContext } from "react";
import { ServerDataContext } from "./ServerDataProvider";

export function updateMeta(meta: any) {
  const { title, description } = meta;
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
  return (
    <head>
      <meta charSet={charSet} />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{meta?.title}</title>
      {meta?.description && (
        <meta name="description" content={meta.description} />
      )}
      {meta?.openGraph && <OpenGraph {...meta.openGraph} />}
      {children}
    </head>
  );
};
