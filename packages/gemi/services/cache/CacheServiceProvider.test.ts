import { describe, expect, test } from "vitest";

import { Cache } from "../../facades/Cache";
import { Application } from "../../foundation/Application";
import { kernelContext } from "../../kernel/context";
import { frameworkProviders } from "../../kernel/providers";
import { Repository } from "../../support/Repository";
import { CacheManager } from "./CacheManager";
import { CacheServiceProvider } from "./CacheServiceProvider";
import { MemoryCacheStore } from "./MemoryCacheStore";

async function makeApp(cache?: Record<string, unknown>) {
  const application = new Application(new Repository(cache ? { cache } : {}));
  application.registerMany([CacheServiceProvider]);
  await application.boot();
  return application;
}

describe("CacheServiceProvider", () => {
  test("is one of the providers every app boots with", () => {
    expect(frameworkProviders).toContain(CacheServiceProvider);
  });

  test("with no app/config/cache.ts, a memory cache with no default ttl", async () => {
    const application = await makeApp();
    const manager = application.make(CacheManager);
    expect(manager.store).toBeInstanceOf(MemoryCacheStore);
    expect(manager.config.ttl).toBeNull();
  });

  test("builds the manager from app/config/cache.ts, and the facade reaches it", async () => {
    const store = new MemoryCacheStore();
    const application = await makeApp({ store: () => store, ttl: "5m" });
    expect(application.make(CacheManager).store).toBe(store);

    await kernelContext.run(application, async () => {
      expect(await Cache.remember("a", () => 1)).toBe(1);
      expect(await Cache.remember("a", "1m", () => 2)).toBe(1);
      await Cache.set("b", { x: 1 });
      expect(await Cache.get("b")).toEqual({ x: 1 });
      expect(await Cache.has("b")).toBe(true);
      expect(await Cache.pull("b")).toEqual({ x: 1 });
      expect(await Cache.delete("a")).toBe(true);
      await Cache.tags("t").set("c", 1);
      await Cache.tags("t").flush();
      expect(await Cache.tags("t").get("c")).toBeUndefined();
      await Cache.flush();
      expect(store.size).toBe(0);
    });
  });
});
