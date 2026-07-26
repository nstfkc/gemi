import { describe, expect, test } from "vitest";

import {
  buildResult,
  estimateUsage,
  previousWeight,
  timeUntilAllowed,
  windowStartFor,
} from "./slidingWindow";

describe("windowStartFor", () => {
  test("aligns windows to the epoch", () => {
    expect(windowStartFor(60_000, 60_000)).toBe(60_000);
    expect(windowStartFor(60_001, 60_000)).toBe(60_000);
    expect(windowStartFor(119_999, 60_000)).toBe(60_000);
    expect(windowStartFor(120_000, 60_000)).toBe(120_000);
  });
});

describe("previousWeight", () => {
  test("decays from a full window to nothing", () => {
    expect(previousWeight(0, 1000)).toBe(1);
    expect(previousWeight(250, 1000)).toBe(0.75);
    expect(previousWeight(1000, 1000)).toBe(0);
  });

  test("clamps outside the window", () => {
    expect(previousWeight(2000, 1000)).toBe(0);
    expect(previousWeight(-500, 1000)).toBe(1);
  });
});

describe("estimateUsage", () => {
  test("weights the previous window by its overlap", () => {
    // Three quarters into the window, a quarter of the previous count remains.
    expect(estimateUsage(10, 100, 750, 1000)).toBe(35);
  });

  test("ignores the previous window once it has fully decayed", () => {
    expect(estimateUsage(10, 100, 1000, 1000)).toBe(10);
  });
});

describe("timeUntilAllowed", () => {
  test("waits only until enough of the previous window decays", () => {
    // usage = 100 * (1000 - e)/1000 + 0, and a limit of 50 needs usage <= 49.
    const wait = timeUntilAllowed({
      current: 0,
      previous: 100,
      elapsed: 0,
      window: 1000,
      limit: 50,
      cost: 1,
    });

    expect(wait).toBe(510);
  });

  test("waits past the boundary when the current window is already full", () => {
    // Nothing frees up while `current` is the live counter; after the roll it
    // becomes `previous` and has to decay to 9 before a 10th request fits.
    const wait = timeUntilAllowed({
      current: 10,
      previous: 0,
      elapsed: 400,
      window: 1000,
      limit: 10,
      cost: 1,
    });

    expect(wait).toBe(600 + 100);
  });

  test("never reports longer than a window for an impossible cost", () => {
    const wait = timeUntilAllowed({
      current: 0,
      previous: 0,
      elapsed: 0,
      window: 1000,
      limit: 5,
      cost: 10,
    });

    expect(wait).toBe(1000);
  });
});

describe("buildResult", () => {
  test("reports the window end and whole remaining requests when allowed", () => {
    const result = buildResult({
      allowed: true,
      current: 3,
      previous: 10,
      now: 60_500,
      elapsed: 500,
      window: 1000,
      limit: 10,
      cost: 1,
    });

    // usage = 10 * 0.5 + 3 = 8
    expect(result).toEqual({
      allowed: true,
      limit: 10,
      remaining: 2,
      resetAt: 61_000,
      retryAfter: 0,
    });
  });

  test("never reports negative headroom", () => {
    const result = buildResult({
      allowed: true,
      current: 12,
      previous: 0,
      now: 1000,
      elapsed: 0,
      window: 1000,
      limit: 10,
      cost: 1,
    });

    expect(result.remaining).toBe(0);
  });

  test("lines resetAt up with the retry delay when denied", () => {
    const result = buildResult({
      allowed: false,
      current: 10,
      previous: 0,
      now: 60_400,
      elapsed: 400,
      window: 1000,
      limit: 10,
      cost: 1,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(700);
    expect(result.resetAt).toBe(60_400 + 700);
  });
});
