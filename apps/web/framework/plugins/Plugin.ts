import { ApiRouter } from "../ApiRouter";
import { ViewRouter } from "../ViewRouter";

export class Plugin {
  public name = Symbol("Plugin");
  public apiRouter = ApiRouter;
  public viewRouter = ViewRouter;
  public apiRoutesBasePath = "";
  public viewRoutesBasePath = "";
}
