// The module surface before ApiRouter exported HttpMethod and CreateRawHttpOutputs.
import { ApiRouter as Router } from "../../../../../http/ApiRouter";
import type { HttpRequest } from "../../../../../http/HttpRequest";
import { HttpResponse } from "../../../../../http/HttpResponse";
export type { ApiRouterHandler, CreateRPC, RouteHandlers } from "../../../../../http/ApiRouter";

export class ApiRouter extends Router {}
export default class LegacyApi extends ApiRouter {
  routes = {
    "/items/:id": this.get((req: HttpRequest<{}, Record<string, string>>) => req.params.id ?? ""),
    "/empty": this.post(() => HttpResponse.noContent()),
  };
}
