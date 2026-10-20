import { describe, expect, test } from "vitest";
import {
  adjust,
  fisherExact,
  meanOf,
  passRate,
  passRateDelta,
  scoreDelta,
  t95,
  tTwoSided,
} from "./stats";

describe("passRate", () => {
  test("a Wilson interval that stays inside [0, 1] at the extremes", () => {
    const all = passRate([true, true, true]);
    expect(all.mean).toBe(1);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.4);
    expect(all.low).toBeLessThan(0.5);

    const none = passRate([false, false, false]);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(1 - all.low!, 10);
  });

  test("two of three", () => {
    const rate = passRate([true, false, true]);
    expect(rate.n).toBe(3);
    expect(rate.mean).toBeCloseTo(2 / 3);
    expect(rate.low).toBeCloseTo(0.2077, 3);
    expect(rate.high).toBeCloseTo(0.9385, 3);
  });

  test("nothing measured", () => {
    expect(passRate([])).toEqual({ n: 0, mean: 0, stddev: 0, low: null, high: null });
  });
});

describe("meanOf", () => {
  test("a t interval", () => {
    const estimate = meanOf([0.5, 0.7, 0.9]);
    expect(estimate.mean).toBeCloseTo(0.7);
    expect(estimate.stddev).toBeCloseTo(0.2);
    // t(2) = 4.303: 0.7 ± 4.303 × 0.2 / √3
    expect(estimate.high! - estimate.mean).toBeCloseTo((4.303 * 0.2) / Math.sqrt(3), 3);
  });

  test("no interval from one value, or from values that never varied", () => {
    expect(meanOf([0.4])).toEqual({ n: 1, mean: 0.4, stddev: 0, low: null, high: null });
    expect(meanOf([0.8, 0.8, 0.8])).toMatchObject({ n: 3, low: null, high: null });
  });
});

describe("distributions", () => {
  test("t critical values match the tables, and are continuous past 30", () => {
    expect(t95(1)).toBeCloseTo(12.706, 2);
    expect(t95(2)).toBeCloseTo(4.303, 3);
    expect(t95(10)).toBeCloseTo(2.228, 3);
    expect(t95(30)).toBeCloseTo(2.042, 3);
    expect(t95(31)).toBeCloseTo(2.04, 3);
    expect(t95(60)).toBeCloseTo(2.0, 2);
    expect(t95(120)).toBeCloseTo(1.98, 2);
    expect(t95(2.94)).toBeGreaterThan(3.1);
    expect(tTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
  });

  test("Fisher's exact test", () => {
    expect(fisherExact(2, 2, 0, 2)).toBeCloseTo(1 / 3, 6);
    expect(fisherExact(4, 4, 0, 4)).toBeCloseTo(2 / 70, 6);
    expect(fisherExact(1, 3, 1, 3)).toBeCloseTo(1, 6);
  });
});

describe("comparisons", () => {
  const scores = (values: number[]) => meanOf(values);
  const rates = (outcomes: boolean[]) => passRate(outcomes);
  const one = (delta: ReturnType<typeof scoreDelta>) => {
    adjust([delta], 0.05, "none");
    return delta;
  };

  test("2/2 → 0/2 is not significant (Fisher p = 1/3)", () => {
    const delta = one(passRateDelta(rates([true, true]), rates([false, false])));
    expect(delta.delta).toBe(-1);
    expect(delta.p).toBeCloseTo(1 / 3, 6);
    expect(delta.significant).toBe(false);
  });

  test("4/4 → 0/4 is", () => {
    const delta = one(passRateDelta(rates([true, true, true, true]), rates([false, false, false, false])));
    expect(delta.significant).toBe(true);
  });

  test("scores without spread on either side are never significant", () => {
    const delta = one(scoreDelta(scores([0.8, 0.8]), scores([0.7, 0.7])));
    expect(delta.p).toBeNull();
    expect(delta.significant).toBe(false);
  });

  test("Welch's t with its own df: [.5,.7,.6] → [.75,.85,.8] is not significant", () => {
    const delta = one(scoreDelta(scores([0.5, 0.7, 0.6]), scores([0.75, 0.85, 0.8])));
    expect(delta.delta).toBeCloseTo(0.2);
    // t = 3.10 on df ≈ 2.94, where the critical value is about 3.2.
    expect(delta.p!).toBeGreaterThan(0.05);
    expect(delta.p!).toBeLessThan(0.06);
    expect(delta.significant).toBe(false);
  });

  test("one score on a side can't be tested", () => {
    expect(scoreDelta(scores([0.9]), scores([0.1, 0.2])).p).toBeNull();
  });

  test("Holm adjusts over the family", () => {
    const deltas = [0.01, 0.02, 0.03, 0.5].map((p) => ({
      before: 1,
      after: 0,
      delta: -1,
      p,
      pAdjusted: p,
      significant: false,
    }));
    adjust(deltas, 0.05, "holm");
    // p × (m − rank), made monotone: 0.04, 0.06, 0.06, 0.5.
    [0.04, 0.06, 0.06, 0.5].forEach((p, at) => expect(deltas[at]!.pAdjusted).toBeCloseTo(p, 10));
    expect(deltas.map((delta) => delta.significant)).toEqual([true, false, false, false]);

    adjust(deltas, 0.05, "none");
    expect(deltas.map((delta) => delta.significant)).toEqual([true, true, true, false]);
  });
});
