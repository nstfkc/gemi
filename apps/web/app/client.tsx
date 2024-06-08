import { hydrateRoot } from "react-dom/client";
import { Main } from "gemi/client";

import { lazy, type ComponentType } from "react";

globalThis.components = Object.entries(
  import.meta.glob(["./views/**/*.tsx", "!./views/**/components/**"]),
).reduce((acc, [path, importer]) => {
  return {
    ...acc,
    [path]: lazy(
      importer as () => Promise<{ default: ComponentType<unknown> }>,
    ),
  };
}, {});

const components = import.meta.glob([
  "./views/**/*.tsx",
  "!./views/**/components/**",
]);

hydrateRoot(
  document.getElementById("root")!,
  <Main components={components} />,
  {},
);
