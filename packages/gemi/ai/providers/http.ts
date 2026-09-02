import { ProviderHttpError, ProviderTimeoutError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RequestOptions = {
  maxRetries: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected by the tests. Nothing here should ever need a real socket to be
   *  exercised, and a retry policy that is only tested against a live API is
   *  one that gets tested during an outage. */
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

/** The floor of the backoff. Doubling from here gives 0.5s, 1s, 2s, 4s — long
 *  enough to outlast a rate-limit window, short enough that a user watching a
 *  stream does not assume it died. */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;

/**
 * `Retry-After` in either of its two legal forms: seconds, or an HTTP date.
 *
 * Honoured rather than ignored because the server knows when its window
 * reopens and we are guessing. A value in the past clamps to zero; a garbage
 * value falls back to the computed backoff, since a header we cannot read is
 * not a reason to give up on the request.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Exponential backoff with full jitter. The jitter is the point: without it,
 * every request that got rate limited at the same moment retries at the same
 * moment, and the second wave is the same size as the first.
 */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function isRetryableStatus(status: number): boolean {
  // 429 and the 5xx range. 409 is in here because OpenAI answers it for a
  // request that raced with something on their side, and it succeeds on the
  // second try.
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

/**
 * One HTTP call, retried.
 *
 * The timeout covers getting a response, not consuming one. A streamed answer
 * legitimately takes minutes, and a timeout that kept running would cut off
 * long completions at exactly the point where they were most expensive to
 * abandon — so the timer is cleared once the headers land, and only the
 * caller's own signal can end the body.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxRetries = Math.max(0, options.maxRetries);

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    options.signal?.throwIfAborted();

    const controller = new AbortController();
    const abortOuter = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortOuter, { once: true });

    let timedOut = false;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.timeoutMs)
        : undefined;

    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortOuter);
      // The caller's abort wins outright — `stop()` means stop, not "stop and
      // try three more times".
      if (options.signal?.aborted) throw error;
      lastError = timedOut ? new ProviderTimeoutError(options.timeoutMs) : error;
      if (attempt === maxRetries) throw lastError;
      await sleep(backoffDelayMs(attempt, random));
      continue;
    }

    if (timer !== undefined) clearTimeout(timer);

    if (response.ok) {
      // Deliberately left attached: the caller is about to read a stream, and
      // its own signal has to keep reaching it.
      return response;
    }

    options.signal?.removeEventListener("abort", abortOuter);
    const body = await readErrorBody(response);
    const error = new ProviderHttpError(
      response.status,
      body,
      response.headers.get("x-request-id") ?? undefined,
    );

    if (!isRetryableStatus(response.status) || attempt === maxRetries) throw error;

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
    await sleep(retryAfter ?? backoffDelayMs(attempt, random));
    lastError = error;
  }

  // Unreachable: the loop either returns or throws. Kept honest rather than
  // asserted away.
  throw lastError ?? new Error("Provider request failed with no response.");
}

async function readErrorBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
