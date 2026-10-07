/**
 * The delay before the retry that follows attempt `attempt`: the number
 * itself, or the array's entry for that retry with its last entry repeated.
 */
export function backoffFor(backoff: number | number[], attempt: number) {
  const delay = Array.isArray(backoff)
    ? backoff[Math.min(attempt, backoff.length) - 1]
    : backoff;
  return Math.max(0, delay ?? 0);
}
