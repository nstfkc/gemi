/**
 * A length of time: milliseconds as a number, or a number and a unit, such as
 * `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"7d"` or `"1w"`.
 */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

/** A `Duration` in milliseconds. Throws for anything else, on the caller's stack. */
export function toMilliseconds(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new TypeError(`A duration is 0 or more milliseconds; got ${duration}.`);
    }
    return Math.round(duration);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/.exec(String(duration));
  if (!match) {
    throw new TypeError(
      `"${String(duration)}" is not a duration. Use milliseconds, or a number and ` +
        `one of ms, s, m, h, d, w ("30s", "7d").`,
    );
  }
  return Math.round(Number(match[1]) * UNITS[match[2]!]!);
}
