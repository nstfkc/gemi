import type { RedisOptions } from "bun";
import { ServiceProvider } from "../ServiceProvider";

export class RedisServiceProvider extends ServiceProvider {
  // Connection URL for Bun's Redis client. Defaults to the `REDIS_URL`
  // environment variable (Bun itself falls back to `redis://localhost:6379`
  // when unset). Override in `app/kernel/providers/RedisServiceProvider.ts`.
  url?: string = process.env.REDIS_URL;

  // Optional Bun Redis client options (TLS, timeouts, auto-reconnect, ...).
  options?: RedisOptions;

  boot() {}
}
