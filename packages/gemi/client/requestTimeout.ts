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
 */
export function startRequestTimeout(
  controller: AbortController | null,
  timeout: number | undefined,
) {
  let timedOut = false;
  const timer =
    controller && typeof timeout === "number" && timeout > 0 && Number.isFinite(timeout)
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeout)
      : null;
  return {
    timedOut: () => timedOut,
    clear: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}
