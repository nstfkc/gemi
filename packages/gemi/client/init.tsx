import { type ComponentType } from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { ServerDataProvider } from "./ServerDataProvider";
import { ClientRouter } from "./ClientRouter";
import { HttpClientProvider } from "./HttpClientContext";

export function init(RootLayout: ComponentType<any>) {
  hydrateRoot(
    document,
    <>
      <></>
      <ServerDataProvider>
        <ClientRouter RootLayout={RootLayout} />
      </ServerDataProvider>
    </>,
  );
}

export function create(
  RootLayout: ComponentType<any>,
  {
    componentTree,
    loaders,
    routeManifest,
    router,
    i18n,
    auth,
    prefetchedData,
    viewImportMap,
    http,
  }: any,
) {
  (window as any).__GEMI_DATA__ = {
    componentTree,
    loaders,
    routeManifest,
    router,
    i18n,
    auth,
    prefetchedData,
    pageData: {},
  };
  createRoot(document.getElementById("root")).render(
    <HttpClientProvider host={http.host} fetch={http.fetch}>
      <ServerDataProvider>
        <ClientRouter viewImportMap={viewImportMap} RootLayout={RootLayout} />
      </ServerDataProvider>
    </HttpClientProvider>,
  );
}
