import { MiddlewareServiceProvider, AuthenticationMiddleware } from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
  };
}
