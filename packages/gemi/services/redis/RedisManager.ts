import { RedisClient } from "bun";
import type { RedisConfig } from "./config";

export class RedisManager {
  static token = "redis";

  // Bun's Redis client. It connects lazily on the first command, so building it
  // in the constructor is safe even when Redis isn't running or configured —
  // nothing connects until something actually issues a command.
  public client: RedisClient;

  constructor(public config: RedisConfig = {}) {
    this.client = new RedisClient(config.url, config.options);
  }
}
