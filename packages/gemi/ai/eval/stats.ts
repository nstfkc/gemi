/**
 * The statistics an eval report carries (#1005): small samples, honestly.
 *
 * An eval run three times that passed twice is "2/3", and the useful thing to
 * say about it is how little that pins down. Pass rates get a Wilson score
 * interval, which stays inside [0, 1] and is not degenerate at 0/n or n/n the
 * way the normal approximation is. Scores get the mean with a t-based
 * interval, since n is usually 1 to 10.
 */

/** A mean with its spread and a 95% interval. `n` is 0 when nothing was measured. */
export type Estimate = {
  n: number;
  mean: number;
  /** The sample standard deviation (n − 1); 0 for n < 2. */
  stddev: number;
  /** The 95% interval's bounds. */
  low: number;
  high: number;
};

const Z95 = 1.959964;

/** Two-sided 95% t quantiles for 1 to 30 degrees of freedom. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
  2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
  2.048, 2.045, 2.042,
];

function t95(df: number): number {
  return df >= 1 && df <= T95.length ? T95[df - 1]! : Z95;
}

const EMPTY: Estimate = { n: 0, mean: 0, stddev: 0, low: 0, high: 0 };

function stddevOf(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  const sum = values.reduce((total, value) => total + (value - mean) ** 2, 0);
  return Math.sqrt(sum / (values.length - 1));
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

/** The mean of `values`, with a t-based 95% interval (none for n = 1). */
export function meanOf(values: readonly number[]): Estimate {
  const n = values.length;
  if (n === 0) return EMPTY;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const stddev = stddevOf(values, mean);
  const margin = n < 2 ? 0 : (t95(n - 1) * stddev) / Math.sqrt(n);
  return { n, mean, stddev, low: mean - margin, high: mean + margin };
}

/** The change from `before` to `after`, and whether it is more than noise. */
export type Delta = {
  before: number;
  after: number;
  delta: number;
  /** Larger than 1.96 standard errors of the difference. */
  significant: boolean;
};

/**
 * Compares two estimates of the same quantity. The standard error of the
 * difference is from both sides' spread. A side measured once has no spread
 * to read, so a change against it is never called significant; with two or
 * more on each side and no spread at all (every run agreed, on both sides),
 * any change is.
 */
export function deltaOf(before: Estimate, after: Estimate): Delta {
  const delta = after.mean - before.mean;
  const variance = (side: Estimate) => (side.n > 0 ? side.stddev ** 2 / side.n : 0);
  const se = Math.sqrt(variance(before) + variance(after));
  const significant =
    before.n > 1 && after.n > 1 && delta !== 0 && (se === 0 || Math.abs(delta) > Z95 * se);
  return { before: before.mean, after: after.mean, delta, significant };
}
