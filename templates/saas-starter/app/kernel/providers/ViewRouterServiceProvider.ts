import { createRoot } from "gemi/client";
import { ViewRouterServiceProvider } from "gemi/services";

import RootViewRouter from "@/app/http/routes/view";
import RootLayout from "@/app/views/RootLayout";

export default class extends ViewRouterServiceProvider {
  rootRouter = RootViewRouter;
  root = createRoot(RootLayout);
}
