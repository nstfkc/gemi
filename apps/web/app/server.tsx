import { Root } from "gemi/client";

globalThis.components = import.meta.glob([
  "./views/**/*.tsx",
  "!./views/**/components/**",
]);

export default Root;
