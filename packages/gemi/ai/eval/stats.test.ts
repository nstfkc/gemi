import { describe, expect, test } from "vitest";
import { deltaOf, meanOf, passRate } from "./stats";

describe("passRate", () => {
  test("a Wilson interval that stays inside [0, 1] at the extremes", () => {
    const all = passRate([true, true, true]);
    expect(all.mean).toBe(1);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.4);
    expect(all.low).toBeLessThan(0.5);

    const none = passRate([false, false, false]);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(1 - all.low, 10);
  });

  test("two of three", () => {
    const rate = passRate([true, false, true]);
    expect(rate.n).toBe(3);
    expect(rate.mean).toBeCloseTo(2 / 3);
    expect(rate.low).toBeCloseTo(0.2077, 3);
    expect(rate.high).toBeCloseTo(0.9385, 3);
  });

  test("nothing measured", () => {
    expect(passRate([])).toEqual({ n: 0, mean: 0, stddev: 0, low: 0, high: 0 });
  });
});

describe("meanOf", () => {
  test("a t interval", () => {
    const estimate = meanOf([0.5, 0.7, 0.9]);
    expect(estimate.mean).toBeCloseTo(0.7);
    expect(estimate.stddev).toBeCloseTo(0.2);
    // t(2) = 4.303: 0.7 ± 4.303 × 0.2 / √3
    expect(estimate.high - estimate.mean).toBeCloseTo((4.303 * 0.2) / Math.sqrt(3), 6);
  });

  test("one value has no interval", () => {
    expect(meanOf([0.4])).toEqual({ n: 1, mean: 0.4, stddev: 0, low: 0.4, high: 0.4 });
  });
});

describe("deltaOf", () => {
  test("a change within the noise is not significant", () => {
    const delta = deltaOf(passRate([true, false, true]), passRate([true, true, false]));
    expect(delta.delta).toBe(0);
    expect(delta.significant).toBe(false);
    expect(deltaOf(passRate([true, false, true, false]), passRate([true, true, true, false])).significant).toBe(false);
  });

  test("a consistent change is", () => {
    const delta = deltaOf(passRate([true, true, true, true]), passRate([false, false, false, false]));
    expect(delta.delta).toBe(-1);
    expect(delta.significant).toBe(true);
  });

  test("one run on a side is never significant", () => {
    expect(deltaOf(passRate([true]), passRate([false, false, false])).significant).toBe(false);
  });
});
