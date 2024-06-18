import RootLayout from "./views/RootLayout";
import { init } from "gemi/client";

// This is a hack to make vite bundle the views
// Will be removed later
if (typeof window !== "undefined") {
  (window as any)._ = import.meta.glob([
    "./views/**/*.tsx",
    "!./views/**/components/**",
    "!/views/RootLayout.tsx",
  ]);
}

init(RootLayout);
