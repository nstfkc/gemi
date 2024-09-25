import { ViewRouterServiceProvider } from "gemi/services";
import RootViewRouter from "../http/router/view";
import RootLayout from "../views/RootLayout";

export default class extends ViewRouterServiceProvider {
  rootRouter = RootViewRouter;
  rootLayout = RootLayout;
}
