import { RedisClient } from "bun";
import { ServiceContainer } from "../ServiceContainer";
import type { RedisServiceProvider } from "./RedisServiceProvider";

export class RedisServiceContainer extends ServiceContainer {
  static _name = "RedisServiceContainer";

  // Bun's Redis client. It connects lazily on the first command, so building it
  // at boot is safe even when Redis isn't running or configured — nothing
  // connects until something actually issues a command.
  public client: RedisClient;

  constructor(public service: RedisServiceProvider) {
    super();
    this.client = new RedisClient(service.url, service.options);
  }
}
