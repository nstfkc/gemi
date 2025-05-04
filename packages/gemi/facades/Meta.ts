import { RequestContext } from "../http/requestContext";

export class Meta {
  protected name = "Meta";
  static description(description: string) {
    RequestContext.getStore().metadata.description(description);
  }
  static title(title: string) {
    RequestContext.getStore().metadata.title(title);
  }
}
