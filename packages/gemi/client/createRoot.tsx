import type { ComponentType } from "react";
import { ClientRouter } from "./ClientRouter";
import { DictionarySinkContext } from "./DictionarySinkContext";
import type { QueryConfig } from "./QueryManagerContext";
import { ServerDataProvider } from "./ServerDataProvider";
import { ServerQueryContext } from "./ServerQueryContext";

export interface CreateRootOptions {
  /**
   * App-wide `useQuery` defaults (per-call config always wins). Set the same
   * value in the client entry's `init` call so hydration matches the server
   * render.
   */
  queryConfig?: QueryConfig;
}

export function createRoot(
  RootLayout: ComponentType<{ children: React.ReactNode; locale: string }>,
  options: CreateRootOptions = {},
) {
  // `serverQueries`, `viewModules` and `dictionarySink` exist only when the view
  // router renders this on the server — the browser mounts with all three absent.
  return (props: any) => (
    <ServerDataProvider value={props.data}>
      <ServerQueryContext.Provider value={props.serverQueries ?? null}>
        <DictionarySinkContext.Provider value={props.dictionarySink ?? null}>
          <ClientRouter
            RootLayout={RootLayout}
            viewImportMap={props.viewImportMap}
            viewModules={props.viewModules}
            queryConfig={options.queryConfig}
          />
        </DictionarySinkContext.Provider>
      </ServerQueryContext.Provider>
    </ServerDataProvider>
  );
}
