import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { InMemoryRateLimiter } from "./InMemoryRateLimiterDriver";

const WINDOW = 1000;

function consume(limiter: InMemoryRateLimiter, key = "a", cost = 1) {
  return limiter.consume({ key, limit: 10, window: WINDOW, cost });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Start on a window boundary so elapsed time in each test is obvious.
  vi.setSystemTime(60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("consume", () => {
  test("admits requests up to the limit and rejects the next one", () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 10; i++) {
      expect(consume(limiter).allowed).toBe(true);
    }

    const denied = consume(limiter);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  test("counts down the remaining budget", () => {
    const limiter = new InMemoryRateLimiter();

    expect(consume(limiter).remaining).toBe(9);
    expect(consume(limiter).remaining).toBe(8);
  });

  test("charges the given cost", () => {
    const limiter = new InMemoryRateLimiter();

    expect(consume(limiter, "a", 4).remaining).toBe(6);
    expect(consume(limiter, "a", 6).remaining).toBe(0);
    expect(consume(limiter, "a", 1).allowed).toBe(false);
  });

  test("keeps keys independent", () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 10; i++) consume(limiter, "a");

    expect(consume(limiter, "a").allowed).toBe(false);
    expect(consume(limiter, "b").allowed).toBe(true);
  });

  test("a full window still blocks right after the boundary", () => {
    const limiter = new InMemoryRateLimiter();

    // Spend the whole budget at the very end of a window — the burst a fixed
    // window would let through twice.
    vi.setSystemTime(60_900);
    for (let i = 0; i < 10; i++) expect(consume(limiter).allowed).toBe(true);

    // 100ms later the window rolls, but 90% of the previous count still counts.
    vi.setSystemTime(61_000);
    expect(consume(limiter).allowed).toBe(false);
  });

  test("lets the budget back in as the previous window decays", () => {
    const limiter = new InMemoryRateLimiter();

    vi.setSystemTime(60_900);
    for (let i = 0; i < 10; i++) consume(limiter);

    // Halfway through the next window: usage is 10 * 0.5 = 5, so five fit.
    vi.setSystemTime(61_500);
    for (let i = 0; i < 5; i++) expect(consume(limiter).allowed).toBe(true);
    expect(consume(limiter).allowed).toBe(false);
  });

  test("starts clean after sitting idle for more than a window", () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 10; i++) consume(limiter);
    expect(consume(limiter).allowed).toBe(false);

    vi.setSystemTime(60_000 + WINDOW * 3);
    expect(consume(limiter).remaining).toBe(9);
  });

  test("resets a key when its window length changes", () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 10; i++) consume(limiter);
    expect(consume(limiter).allowed).toBe(false);

    const result = limiter.consume({ key: "a", limit: 10, window: 5000 });
    expect(result.allowed).toBe(true);
  });

  test("reports the end of the current window as the reset point", () => {
    const limiter = new InMemoryRateLimiter();

    vi.setSystemTime(60_250);
    expect(consume(limiter).resetAt).toBe(61_000);
  });
});

describe("bookkeeping", () => {
  test("stays within maxKeys under keys that never repeat", () => {
    const limiter = new InMemoryRateLimiter({ maxKeys: 10 });

    for (let i = 0; i < 500; i++) {
      limiter.consume({ key: `ip-${i}`, limit: 10, window: WINDOW });
    }

    expect(limiter.size).toBeLessThanOrEqual(10);
  });

  test("evicts the least recently used key first", () => {
    const limiter = new InMemoryRateLimiter({ maxKeys: 2 });

    consume(limiter, "a");
    consume(limiter, "b");
    // Touching "a" makes "b" the oldest, so "b" is what the next key displaces.
    consume(limiter, "a");
    consume(limiter, "c");

    expect(limiter.size).toBe(2);
    expect(consume(limiter, "a").remaining).toBe(7);
    expect(consume(limiter, "b").remaining).toBe(9);
  });

  test("clear() drops every counter", () => {
    const limiter = new InMemoryRateLimiter();

    for (let i = 0; i < 10; i++) consume(limiter);
    expect(consume(limiter).allowed).toBe(false);

    limiter.clear();

    expect(limiter.size).toBe(0);
    expect(consume(limiter).allowed).toBe(true);
  });
});
