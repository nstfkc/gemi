import { create, HttpClientProvider } from "gemi/client";
import { fetch } from "@tauri-apps/plugin-http";
import { lazy } from "react";
import { componentTree, routeManifest } from "virtual:gemi";
import "./app.css";

const glob = import.meta.glob([
  "./views/**/*.tsx",
  "!./views/**/components/**",
  "!/views/RootLayout.tsx",
]);

const viewImportMap: Record<string, () => Promise<any>> = {};

for (const [key, importer] of Object.entries(glob)) {
  const _key = key.replace("./views/", "").replace(".tsx", "");
  viewImportMap[_key] = lazy(importer);
}

create(({ children }) => <>{children}</>, {
  viewImportMap,
  componentTree,
  prefetchedData: {},
  loaders: {},
  auth: { user: null },
  routeManifest,
  router: {
    currentPath: "/",
    params: {},
    pathname: "/",
    searchParams: "",
  },
  i18n: {
    dictionary: {},
    currentLocale: "en-US",
  },
  http: {
    fetch,
    host: "http://localhost:5173",
  },
});
