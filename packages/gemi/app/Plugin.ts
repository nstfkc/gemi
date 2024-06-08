import { ApiRouter } from "../http/ApiRouter";
import { ViewRouter } from "../http/ViewRouter";

export class Plugin {
  public name = Symbol("Plugin");
  public apiRouter = ApiRouter;
  public viewRouter = ViewRouter;
  public apiRoutesBasePath = "";
  public viewRoutesBasePath = "";
}
