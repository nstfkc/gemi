import type { HttpRequest } from "./http/HttpRequest";

export class Controller {
  requests: Record<string, typeof HttpRequest<any>> = {};
}
