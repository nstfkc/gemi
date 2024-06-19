import { type ComponentType } from "react";

import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export function createRoot(RootLayout: ComponentType<any>) {
  return (props: any) => (
    <ServerDataProvider value={props.data}>
      <ClientRouter
        RootLayout={RootLayout}
        viewImportMap={props.viewImportMap}
      />
    </ServerDataProvider>
  );
}
