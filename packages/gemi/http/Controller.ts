import type { HttpRequest } from "./HttpRequest";

export class Controller {
  requests: Record<string, typeof HttpRequest<any>> = {};
}
