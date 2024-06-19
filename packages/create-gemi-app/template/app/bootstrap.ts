import { App } from "gemi/app";
import { createRoot } from "gemi/client";

import apiRouter from "./http/router/api";
import viewRouter from "./http/router/view";

import RootLayout from "./views/RootLayout";

export const app = new App({
  root: createRoot(RootLayout),
  //
  apiRouter,
  viewRouter,
});
