import { hydrateRoot } from "react-dom/client";
import { Main } from "gemi/client";
import { lazy, type ComponentType } from "react";

(window as any).views = Object.entries(
  import.meta.glob(["./views/**/*.tsx", "!./views/**/components/**"]),
).reduce((acc, [path, importer]) => {
  return {
    ...acc,
    [path]: lazy(
      importer as () => Promise<{ default: ComponentType<unknown> }>,
    ),
  };
}, {});

hydrateRoot(document.getElementById("root")!, <Main />, {});
