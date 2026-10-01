import { QueryError } from "./QueryError";

/**
 * What a failed query stores as its `error`: a `QueryError` when the server
 * answered with a non-2xx status, or the `Error` the browser raised when it
 * got no usable answer — a `TypeError` for a network failure, a `SyntaxError`
 * for a 2xx body that is not JSON.
 */
export type QueryFailure = QueryError | Error;

/**
 * Whether a failed query is retried in the background (`suspense: false`
 * queries only — under suspense the error goes to the error boundary).
 *
 * - a number: retry transient failures (see `isRetryableQueryError`) up to that
 *   many times in a row;
 * - `true`: retry transient failures with no cap;
 * - `false` / `0`: never retry;
 * - a function: called after every failure with the number of consecutive
 *   failures so far (1 for the first) and the error. It decides alone, so it
 *   can retry a status the default never does.
 */
export type RetryOption =
  | boolean
  | number
  | ((failureCount: number, error: QueryFailure) => boolean);

/**
 * The wait before a retry, in ms: a number, or a function of the consecutive
 * failure count (1 for the first) and the error. A `Retry-After` header on the
 * failed response wins over either.
 */
export type RetryDelayOption =
  | number
  | ((failureCount: number, error: QueryFailure) => number);

export const DEFAULT_RETRY = 3;
export const DEFAULT_RETRY_BASE_DELAY = 1000;
export const MAX_RETRY_DELAY = 30_000;

/**
 * A failure that another attempt might fix: no answer at all (offline, a
 * dropped connection), a 2xx body that failed to parse, 408, 429 or any 5xx.
 * Every other status — 400, 401, 403, 404, 410, 422, … — says the request
 * itself is the problem, so sending it again gets the same answer.
 */
export function isRetryableQueryError(error: unknown): boolean {
  if (error instanceof QueryError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error != null;
}

export function shouldRetryQuery(
  failureCount: number,
  error: QueryFailure,
  retry: RetryOption | undefined = DEFAULT_RETRY,
): boolean {
  if (typeof retry === "function") return retry(failureCount, error);
  if (retry === false || !isRetryableQueryError(error)) return false;
  if (retry === true) return true;
  return failureCount <= retry;
}

/**
 * `baseDelay * 2^(failureCount - 1)`, capped at 30s: 1s, 2s, 4s, … by default.
 * A `Retry-After` the server sent (a 429 or 503) is honoured as is.
 */
export function retryDelayFor(
  failureCount: number,
  error: QueryFailure,
  retryDelay: RetryDelayOption | undefined,
  baseDelay: number = DEFAULT_RETRY_BASE_DELAY,
): number {
  if (error instanceof QueryError && error.retryAfter !== undefined) {
    return error.retryAfter;
  }
  if (typeof retryDelay === "function") return retryDelay(failureCount, error);
  if (typeof retryDelay === "number") return retryDelay;
  return Math.min(
    baseDelay * 2 ** Math.max(0, failureCount - 1),
    Math.max(MAX_RETRY_DELAY, baseDelay),
  );
}

/**
 * A `Retry-After` header value in ms: delta-seconds or an HTTP date.
 * `undefined` when absent or unreadable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
