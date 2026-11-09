import { hydrateRoot } from "react-dom/client";

import { ClientRouter } from "../../../../client/ClientRouter";
import { documentElement } from "../../../../client/documentTree";
import { ServerDataProvider } from "../../../../client/ServerDataProvider";
import { Layout, views } from "./page";

// What `init` hydrates, with the views bundled in rather than loaded through
// `window.loaders`.
hydrateRoot(
  document,
  documentElement(
    <ServerDataProvider>
      <ClientRouter RootLayout={Layout} viewImportMap={views as never} />
    </ServerDataProvider>,
  ),
  {
    onRecoverableError: (error) => {
      ((window as any).__hydrationErrors ??= []).push(String(error));
    },
  },
);
