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

export const Head = ({
  children = null,
  charSet = "utf-8",
}: { children?: ReactNode; charSet?: string }) => {
  const { meta } = useContext(ServerDataContext);
  return (
    <head>
      <meta charSet={charSet} />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{meta.title}</title>
      {meta.description && (
        <meta name="description" content={meta.description} />
      )}
      {children}
    </head>
  );
};
