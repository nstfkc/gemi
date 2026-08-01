import type { ComponentType } from "react";
import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";
import { ServerQueryContext } from "./ServerQueryContext";

export function createRoot(
  RootLayout: ComponentType<{ children: React.ReactNode; locale: string }>,
) {
  // `serverQueries` and `viewModules` exist only when the view router renders
  // this on the server — the browser mounts with both absent.
  return (props: any) => (
    <ServerDataProvider value={props.data}>
      <ServerQueryContext.Provider value={props.serverQueries ?? null}>
        <ClientRouter
          RootLayout={RootLayout}
          viewImportMap={props.viewImportMap}
          viewModules={props.viewModules}
        />
      </ServerQueryContext.Provider>
    </ServerDataProvider>
  );
}
