import { afterEach, describe, expect, test, vi } from "vitest";

const warning = vi.fn();
vi.mock("../../facades/Log", () => ({ Log: { warning, error: vi.fn() } }));

const { RateLimiterServiceProvider } = await import("./RateLimiterServiceProvider");
const { InMemoryRateLimiter } = await import("./drivers/InMemoryRateLimiterDriver");
const { DatabaseRateLimiter } = await import("./drivers/DatabaseRateLimiterDriver");
const { MemoryLockStore } = await import("../lock/MemoryLockStore");
const { DatabaseQueueDriver } = await import("../queue/DatabaseQueueDriver");

/**
 * Boots the provider with these config slices standing in for `app/config`,
 * and `queue` as the bound `QueueManager`'s driver, if given.
 */
async function boot(slices: Record<string, unknown>, queue?: unknown) {
  const app = {
    singleton: () => {},
    config: { get: (key: string, fallback: unknown) => slices[key] ?? fallback },
    bound: () => queue !== undefined,
    make: () => ({ driver: queue }),
  } as any;
  await new RateLimiterServiceProvider(app).boot();
}

afterEach(() => {
  warning.mockClear();
  vi.unstubAllEnvs();
});

describe("the boot warning (#1341)", () => {
  test("in production, a database queue with the default in-memory limits is warned about", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await boot({ queue: { driver: "database" } });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]![0]).toContain("DatabaseRateLimiter");

    // The function form, read from the queue it built.
    const database = Object.create(DatabaseQueueDriver.prototype);
    await boot({ queue: { driver: () => database } }, database);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  test("a chosen driver, a memory queue, or a non-production process is not", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Chosen on purpose: one instance, say.
    await boot({ queue: { driver: "database" }, ratelimiter: { driver: new InMemoryRateLimiter() } });
    await boot({ queue: { driver: () => ({}) } }, {});
    await boot({
      queue: { driver: "database" },
      ratelimiter: { driver: new DatabaseRateLimiter({ store: new MemoryLockStore() }) },
    });
    await boot({ queue: { driver: "memory" } });
    await boot({});
    vi.stubEnv("NODE_ENV", "development");
    await boot({ queue: { driver: "database" } });
    expect(warning).not.toHaveBeenCalled();
  });
});
