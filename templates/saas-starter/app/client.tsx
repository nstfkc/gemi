import { init } from "gemi/client";
import RootLayout from "./views/RootLayout";

init(
  RootLayout,
  import.meta.glob([
    "./views/**/*.tsx",
    "!./views/**/components/**",
    "!./views/**/assets/**",
    "!/views/RootLayout.tsx",
  ]),
);
