import { ApiRouterServiceProvider } from "gemi/services";
import RootApiRouter from "@/app/http/routes/api";

export default class extends ApiRouterServiceProvider {
  rootRouter = RootApiRouter;
}
