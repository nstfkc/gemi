import { ServiceProvider } from "../services/ServiceProvider";
import { Middleware } from "./Middleware";

export class MiddlewareServiceProvider extends ServiceProvider {
  aliases: Record<string, new (routePath: string) => Middleware> = {};

  boot() {}
}
