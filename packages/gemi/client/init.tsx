import { type ComponentType } from "react";
import { hydrateRoot } from "react-dom/client";
import { ServerDataProvider } from "./ServerDataProvider";
import { ClientRouter } from "./ClientRouter";

export function init(RootLayout: ComponentType<any>) {
  hydrateRoot(
    document,
    <>
      <></>
      <ServerDataProvider>
        <ClientRouter RootLayout={RootLayout} />
      </ServerDataProvider>
    </>,
    {
      onRecoverableError: (error, errorInfo) => {
        console.log({ error, errorInfo });
      },
    },
  );
}
