import { App } from "gemi/app";
import { createRoot } from "gemi/client";

import ApiRouter from "./http/router/api";
import ViewRouter from "./http/router/view";

import RootLayout from "./views/RootLayout";
import Kernel from "./kernel/Kernel";

export const app = new App({
  root: createRoot(RootLayout),
  //
  apiRouter: ApiRouter,
  viewRouter: ViewRouter,
  kernel: Kernel,
});
