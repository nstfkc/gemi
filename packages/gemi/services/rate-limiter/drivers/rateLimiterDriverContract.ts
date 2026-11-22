import { afterEach, describe, expect, test } from "vitest";

import type { RateLimiterDriver } from "./RateLimiterDriver";

/**
 * What every rate-limiter driver promises (#1341), whatever its window shape:
 * the in-memory and Redis drivers count a sliding window, the database driver
 * a fixed one, so only what holds for both is asserted here.
 *
 * `make` answers a driver over fresh, empty storage; `driver()` may be called
 * more than once, and each call is another client of the same storage.
 */
export type RateLimiterDriverSubject = {
  driver: () => RateLimiterDriver;
  dispose?: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function rateLimiterDriverContract(
  name: string,
  make: () => Promise<RateLimiterDriverSubject>,
) {
  describe(`${name}: the rate-limiter driver contract`, () => {
    let subject: RateLimiterDriverSubject | undefined;

    afterEach(async () => {
      await subject?.dispose?.();
      subject = undefined;
    });

    const open = async () => (subject = await make());
    const consume = (driver: RateLimiterDriver, key: string, limit: number, cost?: number) =>
      Promise.resolve(driver.consume({ key, limit, window: 60_000, cost }));

    test("admits up to the limit, counting down, then refuses with a wait", async () => {
      const driver = (await open()).driver();
      const first = await consume(driver, "a", 3);
      expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, retryAfter: 0 });
      expect(first.resetAt).toBeGreaterThan(Date.now());
      expect(await consume(driver, "a", 3)).toMatchObject({ allowed: true, remaining: 1 });
      expect(await consume(driver, "a", 3)).toMatchObject({ allowed: true, remaining: 0 });

      const refused = await consume(driver, "a", 3);
      expect(refused).toMatchObject({ allowed: false, limit: 3, remaining: 0 });
      expect(refused.retryAfter).toBeGreaterThan(0);
      // A sliding window can make a full budget wait into the next window.
      expect(refused.retryAfter).toBeLessThanOrEqual(2 * 60_000);
      expect(refused.resetAt).toBeGreaterThan(Date.now());
    });

    test("keys are counted apart", async () => {
      const driver = (await open()).driver();
      expect((await consume(driver, "a", 1)).allowed).toBe(true);
      expect((await consume(driver, "a", 1)).allowed).toBe(false);
      expect((await consume(driver, "b", 1)).allowed).toBe(true);
    });

    test("a cost spends that much, and a refused call spends nothing", async () => {
      const driver = (await open()).driver();
      expect(await consume(driver, "c", 5, 3)).toMatchObject({ allowed: true, remaining: 2 });
      expect((await consume(driver, "c", 5, 3)).allowed).toBe(false);
      expect(await consume(driver, "c", 5, 2)).toMatchObject({ allowed: true, remaining: 0 });
      expect((await consume(driver, "c", 5, 1)).allowed).toBe(false);
    });

    test("a cost above the limit never fits, even on a fresh key", async () => {
      const driver = (await open()).driver();
      expect((await consume(driver, "big", 5, 6)).allowed).toBe(false);
      // And it spent nothing.
      expect(await consume(driver, "big", 5, 5)).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("every client of the storage shares one budget", async () => {
      const s = await open();
      expect((await consume(s.driver(), "shared", 2)).allowed).toBe(true);
      expect((await consume(s.driver(), "shared", 2)).allowed).toBe(true);
      expect((await consume(s.driver(), "shared", 2)).allowed).toBe(false);
    });

    test("concurrent calls never admit more than the limit", async () => {
      const s = await open();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => consume(s.driver(), "race", 5)),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(5);
    });

    test("the budget comes back once the windows pass", async () => {
      const driver = (await open()).driver();
      const WINDOW = 400;
      const spend = () => Promise.resolve(driver.consume({ key: "w", limit: 2, window: WINDOW }));
      expect((await spend()).allowed).toBe(true);
      expect((await spend()).allowed).toBe(true);
      expect((await spend()).allowed).toBe(false);
      // Two windows: a sliding window still weighs the previous one for one more.
      await sleep(2 * WINDOW + 100);
      expect((await spend()).allowed).toBe(true);
      expect((await spend()).allowed).toBe(true);
    });
  });
}
