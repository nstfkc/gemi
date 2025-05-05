import { createElement, Fragment, type ReactNode } from "react";
import type { SatoriOptions } from "satori";

type Font = Omit<SatoriOptions["fonts"][number], "data">;
type Options = Omit<SatoriOptions, "fonts"> & {
  fonts: Font[];
} & { width: number; height: number };

export const OpenGraphImage = ({
  children,
  ...satoriOptions
}: Options & { children: ReactNode }) => {
  return (
    <>
      {(() => {
        throw {
          x: "1",
          jsx: createElement(Fragment, { children }),
          satoriOptions,
        };
      })()}
    </>
  );
};
