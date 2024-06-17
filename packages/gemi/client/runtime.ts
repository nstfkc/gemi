import { lazy } from "react";
(window as any).views = Object.entries((window as any).manifest).reduce(
  (acc, [path, importer]) => {
    return {
      ...acc,
      [path]: lazy(importer as any),
    };
  },
  {},
);
