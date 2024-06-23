import { App } from "../app/App";
import type { HttpRequest } from "./HttpRequest";

export class Controller {
  requests: Record<string, typeof HttpRequest<any>> = {};

  static kind = "controller" as const;

  constructor(private app: App) {}
}
