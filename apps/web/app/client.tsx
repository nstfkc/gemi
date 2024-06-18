import RootLayout from "./views/RootLayout";
import { hydrateRoot } from "react-dom/client";

if (typeof window !== "undefined") {
  (window as any)._ = import.meta.glob([
    "./views/**/*.tsx",
    "!./views/**/components/**",
    "!/views/RootLayout.tsx",
  ]);
}

hydrateRoot(document.body, <RootLayout />, {});
