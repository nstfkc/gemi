import { hydrateRoot } from "react-dom/client";
import { Main, registerViews } from "gemi/client";

registerViews(
  import.meta.glob(["./views/**/*.tsx", "!./views/**/components/**"]),
);

hydrateRoot(document.getElementById("root")!, <Main />, {});
