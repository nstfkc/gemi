import { requestContext } from "../http/requestContext";

export class Auth {
  static user() {
    const requestContextStore = requestContext.getStore();
    if (requestContextStore) {
      return requestContextStore.get("user");
    }
  }
}
