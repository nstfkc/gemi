/**
 * What a query or mutation fails with when its `timeout` passed before the
 * answer (headers and body) arrived. The request is aborted. For a query it
 * is a network failure like any other: `isRetryableQueryError` is `true`, so
 * `retry` retries it.
 */
export class RequestTimeoutError extends Error {
  constructor(
    public url: string,
    public timeout: number,
  ) {
    super(`Request to ${url} timed out after ${timeout}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Abort `controller` once `timeout` ms have passed. No timer for an unset,
 * zero, negative or non-finite timeout. `timedOut()` tells the caller's
 * `catch` that the abort was this timer, not a cancel; `clear()` runs once
 * the request settles.
 *
 * `tighten(timeout)` applies a smaller timeout to the request already on the
 * wire, counted from when it was sent (a larger one changes nothing);
 * `timeout()` is the one in force.
 */
export function startRequestTimeout(
  controller: AbortController | null,
  timeout: number | undefined,
) {
  const startedAt = Date.now();
  let timedOut = false;
  let settled = false;
  let current: number | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tighten = (next: number | undefined) => {
    if (!controller || settled) return;
    if (typeof next !== "number" || !(next > 0) || !Number.isFinite(next)) return;
    if (current !== undefined && next >= current) return;
    current = next;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, startedAt + next - Date.now()),
    );
  };
  tighten(timeout);
  return {
    timedOut: () => timedOut,
    timeout: () => current,
    tighten,
    clear: () => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}
