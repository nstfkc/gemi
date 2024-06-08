import { App } from "gemi/app";
import { RootApiRouter } from "./http/router/RootApiRouter";
import { RootViewRouter } from "./http/router/RootViewRouter";
import { AuthMiddleware } from "./http/middlewares/AuthMiddleware";
import { UserMiddleware } from "./http/middlewares/UserMiddleware";

export const app = new App({
  apiRouter: RootApiRouter,
  viewRouter: RootViewRouter,
  middlewareAliases: {
    auth: AuthMiddleware,
    user: UserMiddleware,
  },
});
