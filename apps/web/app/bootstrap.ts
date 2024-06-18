import { App } from "gemi/app";

import ApiRouter from "./http/router/api";
import ViewRouter from "./http/router/view";

import RootLayout from "./views/RootLayout";

import { AuthMiddleware } from "./http/middlewares/AuthMiddleware";
import { UserMiddleware } from "./http/middlewares/UserMiddleware";

export const app = new App({
  RootLayout,
  //
  apiRouter: ApiRouter,
  viewRouter: ViewRouter,
  middlewareAliases: {
    auth: AuthMiddleware,
    user: UserMiddleware,
  },
});
