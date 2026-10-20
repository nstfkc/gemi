/**
 * The statistics an eval report carries (#1005): small samples, honestly.
 *
 * An eval run three times that passed twice is "2/3", and the useful thing to
 * say about it is how little that pins down. Pass rates get a Wilson score
 * interval, which stays inside [0, 1] and is not degenerate at 0/n or n/n the
 * way the normal approximation is. Scores get the mean with a t interval,
 * since n is usually 1 to 10, and none at all where there is no spread to
 * read one from (one value, or every value the same).
 *
 * Comparisons use exact or small-sample tests for the same reason: Fisher's
 * exact test for pass rates, Welch's t for scores. A z-test on two runs of
 * 0/1 values calls almost anything significant.
 */

/** A mean with its spread and a 95% interval. `n` is 0 when nothing was measured. */
export type Estimate = {
  n: number;
  mean: number;
  /** The sample standard deviation (n − 1); 0 for n < 2. */
  stddev: number;
  /**
   * The 95% interval's bounds, or `null` when the data can't give one: a
   * score measured once, or a score that came out the same every time (that
   * it didn't vary in n runs is not evidence that it can't).
   */
  low: number | null;
  high: number | null;
};

const EMPTY: Estimate = { n: 0, mean: 0, stddev: 0, low: null, high: null };

const Z95 = 1.959964;

// --- distributions -------------------------------------------------------------

/** ln Γ(x), Lanczos (g = 7, n = 9). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The continued fraction of the incomplete beta function (Numerical Recipes). */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(a, b, x)) / a
    : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/** P(|T| ≥ |t|) for Student's t with `df` degrees of freedom (any df > 0). */
export function tTwoSided(t: number, df: number): number {
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** The two-sided 95% critical value of Student's t, for any df > 0. */
export function t95(df: number): number {
  if (!(df > 0)) return Number.POSITIVE_INFINITY;
  // tTwoSided falls as t grows: bisect for the t where it is 0.05.
  let low = Z95;
  let high = 2;
  while (tTwoSided(high, df) > 0.05) high *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    if (tTwoSided(mid, df) > 0.05) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Two-sided p of Fisher's exact test on a 2×2 table (passes out of n on each side). */
export function fisherExact(passA: number, nA: number, passB: number, nB: number): number {
  const passes = passA + passB;
  const n = nA + nB;
  const lnChoose = (top: number, k: number) =>
    lnGamma(top + 1) - lnGamma(k + 1) - lnGamma(top - k + 1);
  const probability = (k: number) =>
    Math.exp(lnChoose(nA, k) + lnChoose(nB, passes - k) - lnChoose(n, passes));
  const observed = probability(passA);
  let p = 0;
  for (let k = Math.max(0, passes - nB); k <= Math.min(nA, passes); k++) {
    const each = probability(k);
    // A relative tolerance, so tables as likely as the observed one count
    // despite rounding.
    if (each <= observed * (1 + 1e-7)) p += each;
  }
  return Math.min(1, p);
}

// --- estimates ------------------------------------------------------------------

function stddevOf(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  const sum = values.reduce((total, value) => total + (value - mean) ** 2, 0);
  const stddev = Math.sqrt(sum / (values.length - 1));
  // Values that are all equal can still leave a residue from rounding the
  // mean (0.8 three times): that is no spread, not a tiny one.
  return stddev < 1e-12 * Math.max(1, Math.abs(mean)) ? 0 : stddev;
}

/** The pass rate of `outcomes`, with a Wilson 95% interval. */
export function passRate(outcomes: readonly boolean[]): Estimate {
  const n = outcomes.length;
  if (n === 0) return EMPTY;
  const values = outcomes.map((pass) => (pass ? 1 : 0));
  const p = values.reduce<number>((sum, value) => sum + value, 0) / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return {
    n,
    mean: p,
    stddev: stddevOf(values, p),
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

/** The mean of `values`, with a t 95% interval (none without spread). */
export function meanOf(values: readonly number[]): Estimate {
  const n = values.length;
  if (n === 0) return EMPTY;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const stddev = stddevOf(values, mean);
  if (n < 2 || stddev === 0) return { n, mean, stddev, low: null, high: null };
  const margin = (t95(n - 1) * stddev) / Math.sqrt(n);
  return { n, mean, stddev, low: mean - margin, high: mean + margin };
}

// --- comparisons -----------------------------------------------------------------

/** The change from `before` to `after`, and whether it is more than noise. */
export type Delta = {
  before: number;
  after: number;
  delta: number;
  /**
   * The test's two-sided p: Fisher's exact test for a pass rate, Welch's t for
   * a score. `null` when it can't be tested: a side with no samples, a score
   * measured once on a side, or scores without any spread on either side.
   */
  p: number | null;
  /** `p` adjusted for every comparison in the same `compare` (Holm, unless
   *  `adjust: "none"`). */
  pAdjusted: number | null;
  /** `pAdjusted` below the comparison's `alpha`. */
  significant: boolean;
};

function untested(before: Estimate, after: Estimate, p: number | null): Delta {
  return {
    before: before.mean,
    after: after.mean,
    delta: after.mean - before.mean,
    p,
    pAdjusted: p,
    significant: false,
  };
}

/** Two pass rates, by Fisher's exact test. */
export function passRateDelta(before: Estimate, after: Estimate): Delta {
  if (before.n === 0 || after.n === 0) return untested(before, after, null);
  const passes = (side: Estimate) => Math.round(side.mean * side.n);
  return untested(before, after, fisherExact(passes(before), before.n, passes(after), after.n));
}

/** Two mean scores, by Welch's t with the Welch–Satterthwaite df. */
export function scoreDelta(before: Estimate, after: Estimate): Delta {
  if (before.n < 2 || after.n < 2) return untested(before, after, null);
  const vb = before.stddev ** 2 / before.n;
  const va = after.stddev ** 2 / after.n;
  const se = Math.sqrt(vb + va);
  // No spread on either side: nothing to tell a change from noise with.
  if (se === 0) return untested(before, after, null);
  const df = (vb + va) ** 2 / (vb ** 2 / (before.n - 1) + va ** 2 / (after.n - 1));
  return untested(before, after, tTwoSided((after.mean - before.mean) / se, df));
}

/**
 * Sets each `pAdjusted` and `significant` over a family of comparisons.
 *
 * `"holm"` (the default in `compare`) is Holm's step-down adjustment: it keeps
 * the chance of any false "significant" across the whole family under
 * `alpha`, which is what a CI gate reading `regressions` needs when one
 * `compare` tests every case and grader on two measures. `"none"` tests each
 * at `alpha` on its own.
 */
export function adjust(deltas: readonly Delta[], alpha: number, method: "holm" | "none"): void {
  if (method === "holm") {
    const sorted = deltas.filter((entry) => entry.p !== null).sort((a, b) => a.p! - b.p!);
    let running = 0;
    sorted.forEach((entry, rank) => {
      running = Math.max(running, Math.min(1, entry.p! * (sorted.length - rank)));
      entry.pAdjusted = running;
    });
  } else {
    for (const entry of deltas) entry.pAdjusted = entry.p;
  }
  for (const entry of deltas) {
    entry.significant = entry.pAdjusted !== null && entry.pAdjusted < alpha && entry.delta !== 0;
  }
}
