import { ServiceProvider } from "../services/ServiceProvider";
import { HttpRequest } from "./HttpRequest";
import { Middleware } from "./Middleware";

export class MiddlewareServiceProvider extends ServiceProvider {
  aliases: Record<string, new (req: HttpRequest) => Middleware> = {};

  boot() {}
}
