import { HttpRequest } from "./HttpRequest";

export class Middleware {
  constructor(protected req: HttpRequest) {}
  run(..._args: any[]): Promise<any> | any {
    return {};
  }
}
