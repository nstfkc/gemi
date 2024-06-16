import { App } from "gemi/app";
import ApiRouter from "./http/router/api";
import ViewRouter from "./http/router/view";
import { AuthMiddleware } from "./http/middlewares/AuthMiddleware";
import { UserMiddleware } from "./http/middlewares/UserMiddleware";
import RootLayout from "./views/RootLayout";

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
