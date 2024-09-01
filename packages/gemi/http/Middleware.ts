import { HttpRequest } from "./HttpRequest";

export class Middleware {
  constructor(public routePath: string) {}
  async run(_req: HttpRequest, ..._args: any[]) {
    return {};
  }
}
