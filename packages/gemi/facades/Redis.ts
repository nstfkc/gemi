import type { RedisClient } from "bun";
import { RedisManager } from "../services/redis/RedisManager";
import { Facade } from "./Facade";

// Ergonomic access to the app's Redis client. Use `Redis.client` for the full
// Bun Redis API (hashes, sets, sorted sets, pub/sub, pipelining, ...); the
// static shortcuts below cover the most common string commands.
export class Redis extends Facade {
  static getFacadeAccessor() {
    return RedisManager;
  }

  static get client(): RedisClient {
    return this.getFacadeRoot().client;
  }

  static get(key: string) {
    return Redis.client.get(key);
  }

  static set(key: string, value: string) {
    return Redis.client.set(key, value);
  }

  static del(...keys: string[]) {
    return Redis.client.del(...keys);
  }

  static exists(key: string) {
    return Redis.client.exists(key);
  }

  static incr(key: string) {
    return Redis.client.incr(key);
  }

  static expire(key: string, seconds: number) {
    return Redis.client.expire(key, seconds);
  }

  static ttl(key: string) {
    return Redis.client.ttl(key);
  }
}
