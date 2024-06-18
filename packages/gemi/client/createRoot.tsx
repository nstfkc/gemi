import { type ComponentType } from "react";

import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

export function createRoot(RootLayout: ComponentType<any>) {
  return (props: any) => (
    <RootLayout>
      <ServerDataProvider value={props.data}>
        <ClientRouter viewImportMap={props.viewImportMap} />
      </ServerDataProvider>
    </RootLayout>
  );
}
