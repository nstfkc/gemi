import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import { CacheManager } from "./CacheManager";
import { RedisCacheStore } from "./RedisCacheStore";

/**
 * `RedisCacheStore` and the manager on a real Redis through Bun's client: the
 * reply shapes the unit test's fake assumes (`SCAN`'s `[cursor, keys]`, `GET`'s
 * `null`, `DEL`'s count) are Bun's, PX expiry is Redis's, and two managers
 * share tags through one server.
 *
 * Runs when `TEST_REDIS_URL` is set (CI's `redis` job brings a Redis service
 * up); skipped loudly otherwise, and failed instead when `CI_REDIS_REQUIRED=1`.
 */

const REDIS_URL = process.env.TEST_REDIS_URL;

if (!REDIS_URL) {
  describe("RedisCacheStore on a real Redis", () => {
    const name = "did NOT run: set TEST_REDIS_URL";
    if (process.env.CI_REDIS_REQUIRED === "1") {
      test(name, () => {
        throw new Error("This run must reach Redis. Not set: TEST_REDIS_URL.");
      });
    } else {
      test.skip(name, () => {});
    }
  });
} else {
  suite(REDIS_URL);
}

function suite(url: string) {
  describe("RedisCacheStore on a real Redis", () => {
    const client = new (globalThis as any).Bun.RedisClient(url);
    const prefix = `gemi-test:${randomBytes(6).toString("hex")}:`;
    const store = new RedisCacheStore({ client, prefix });

    afterAll(async () => {
      await store.flush();
      client.close();
    });

    test("get, set, delete", async () => {
      expect(await store.get("missing")).toBeNull();
      await store.set("a", "1", null);
      expect(await store.get("a")).toBe("1");
      expect(await store.delete("a")).toBe(true);
      expect(await store.delete("a")).toBe(false);
    });

    test("expires by PX", async () => {
      await store.set("short", "1", 50);
      expect(await store.get("short")).toBe("1");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await store.get("short")).toBeNull();
    });

    test("flush removes its prefix only, over several SCAN pages", async () => {
      for (let i = 0; i < 1_200; i++) await store.set(`many:${i}`, "x", null);
      const other = `${prefix.slice(0, -1)}-other:keep`;
      await client.send("SET", [other, "1"]);

      await store.flush();

      expect(await store.get("many:0")).toBeNull();
      expect(await store.get("many:1199")).toBeNull();
      expect(await client.send("GET", [other])).toBe("1");
      await client.send("DEL", [other]);
    });

    test("two managers on one Redis share values and tag flushes", async () => {
      const one = new CacheManager({ store });
      const two = new CacheManager({ store: new RedisCacheStore({ client, prefix }) });

      await one.set("plan", { steps: [1, 2] }, "1m");
      expect(await two.get("plan")).toEqual({ steps: [1, 2] });

      await one.tags("user:1").set("billing", "pro", "1m");
      expect(await two.tags("user:1").get("billing")).toBe("pro");
      await two.tags("user:1").flush();
      expect(await one.tags("user:1").get("billing")).toBeUndefined();
    });
  });
}
