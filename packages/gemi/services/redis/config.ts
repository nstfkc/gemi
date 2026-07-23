import type { RedisOptions } from "bun";

// Config key: `redis`. Derived from `RedisServiceProvider`.
export interface RedisConfig {
  // Connection URL for Bun's Redis client. Defaults to the `REDIS_URL`
  // environment variable (Bun itself falls back to `redis://localhost:6379`
  // when unset).
  url?: string;

  // Optional Bun Redis client options (TLS, timeouts, auto-reconnect, ...).
  options?: RedisOptions;
}

export function defineRedisConfig(config: RedisConfig): RedisConfig {
  return config;
}

export function redisConfigDefaults(): RedisConfig {
  return {
    url: process.env.REDIS_URL,
    options: undefined,
  };
}
