import { ApiRouterServiceProvider } from "gemi/services";
import RootApiRouter from "../http/router/api";

export default class extends ApiRouterServiceProvider {
  override rootRouter = RootApiRouter;

  boot() {
    return "test";
  }
}
