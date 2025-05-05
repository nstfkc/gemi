import type { OpenGraphParams } from "../http/Metadata";
import { RequestContext } from "../http/requestContext";

export class Meta {
  protected name = "Meta";
  static description(description: string) {
    RequestContext.getStore().metadata.description(description);
  }
  static title(title: string) {
    RequestContext.getStore().metadata.title(title);
  }
  static openGraph(params: OpenGraphParams) {
    RequestContext.getStore().metadata.openGraph(params);
  }
}
