import { ViewRouterServiceProvider } from "gemi/services";
import { createRoot } from "gemi/client";

import RootViewRouter from "../http/router/view";
import RootLayout from "../views/RootLayout";

export default class extends ViewRouterServiceProvider {
  rootRouter = RootViewRouter;
  root = createRoot(RootLayout);
}
