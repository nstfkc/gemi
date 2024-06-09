import { App } from "../app/App";
import type { HttpRequest } from "./HttpRequest";

export class Controller {
  requests: Record<string, typeof HttpRequest<any>> = {};

  constructor(public app: App) {}
}
