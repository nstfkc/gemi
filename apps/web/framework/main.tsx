import { hydrateRoot } from "react-dom/client";

import { ClientRouter } from "./ClientRouter";
import { ServerDataProvider } from "./ServerDataProvider";

/* async function preloadComponents() {
 *   await Promise.all(
 *     window.preloadModules.map((modulePath) => {
 *       return import(modulePath);
 *     }),
 *   );
 * } */

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
