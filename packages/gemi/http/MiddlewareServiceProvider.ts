import { Middleware } from "./Middleware";

export class MiddlewareServiceProvider {
  aliases: Record<string, new (routePath: string) => Middleware> = {};
}
