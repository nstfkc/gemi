import { HttpRequest } from "./HttpRequest";

export class Middleware {
  async run(_req: HttpRequest, ctx: Map<string, any>) {
    return {};
  }
}
