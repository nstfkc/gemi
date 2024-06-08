import { hydrateRoot } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

hydrateRoot(
  document.getElementById("root")!,
  <>
    <></>
    <ServerDataProvider>
      <ClientRouter />
    </ServerDataProvider>
  </>,
  {},
);
