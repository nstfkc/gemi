import type { ViewRouter } from "../../http/ViewRouter";
import { ServiceProvider } from "../ServiceProvider";

export class ViewRouterServiceProvider extends ServiceProvider {
  root: (props: any) => JSX.Element;
  rootRouter: new () => ViewRouter;

  boot() {}
}
