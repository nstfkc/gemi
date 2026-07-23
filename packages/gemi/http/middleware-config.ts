import type { HttpRequest } from "./HttpRequest";
import type { Middleware } from "./Middleware";

// Config key: `middleware`. Derived from `MiddlewareServiceProvider`.
export interface MiddlewareConfig {
  aliases?: Record<string, new (req: HttpRequest) => Middleware>;
}

export function defineMiddlewareConfig(
  config: MiddlewareConfig,
): MiddlewareConfig {
  return config;
}

export function middlewareConfigDefaults(): Required<MiddlewareConfig> {
  return {
    aliases: {},
  };
}
