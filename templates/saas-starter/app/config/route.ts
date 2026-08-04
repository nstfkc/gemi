import { createRoot } from "gemi/client";
import { defineRouteConfig } from "gemi/services";

import RootApiRouter from "@/app/http/routes/api";
import RootViewRouter from "@/app/http/routes/view";
import RootLayout from "@/app/views/RootLayout";

export default defineRouteConfig({
  api: {
    rootRouter: RootApiRouter,
  },
  view: {
    rootRouter: RootViewRouter,
    root: createRoot(RootLayout),
  },
});
