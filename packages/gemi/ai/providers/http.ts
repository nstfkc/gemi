import { normalizeProviderError, ProviderHttpError, ProviderTimeoutError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RequestOptions = {
  maxRetries: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected by the tests. Nothing here should ever need a real socket to be
   *  exercised, and a retry policy that is only tested against a live API is
   *  one that gets tested during an outage. */
  fetchImpl?: FetchLike;
  /** Takes the caller's signal so the default can clear its timer rather than
   *  hold the process open for a backoff nobody is waiting for any more. An
   *  injected sleep may ignore it: the wait is raced against the abort either
   *  way. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /**
   * Whether a timeout is worth another attempt. Defaults to `true`.
   *
   * THE ANSWER DEPENDS ON WHAT THE TIMER BOUNDS, which is why this is a
   * parameter and not a policy. For a streamed call the timer covers getting a
   * response and is cleared once the headers land (see `requestWithRetry`), so a
   * timeout means the provider never started answering: nothing was generated,
   * nothing was billed, and retrying is both cheap and likely to work.
   *
   * For a call that returns its whole result in one body, the same timer bounds
   * the *work*. A timeout there means the work probably happened and we hung up
   * before hearing about it — so a retry pays for it a second time, at the same
   * latency, and most likely times out again.
   *
   * MEASURED, because the margin is what makes this urgent rather than
   * theoretical. One `gpt-image-2` render at `quality: "high"`, `1536x1024`,
   * against a real Azure deployment: **117.8 seconds**, against a
   * `DEFAULT_TIMEOUT_MS` of 120_000. Two seconds of headroom, about 2%. Any
   * variance crosses it, and with retries on, one such request becomes three
   * two-minute renders, six minutes of waiting, three images billed, and a
   * `ProviderTimeoutError` returned to the caller. (For scale: the same model at
   * `low`/1024² answers in 15s, and an edit in 14–20s.)
   *
   * So the image path passes `false` and the streaming path leaves it alone. A
   * 429 or a 5xx is still retried in both cases: those say the request did not
   * run, which is the opposite of what a timeout says here.
   */
  retryTimeouts?: boolean;
};

/** The floor of the backoff. Doubling from here gives 0.5s, 1s, 2s, 4s — long
 *  enough to outlast a rate-limit window, short enough that a user watching a
 *  stream does not assume it died. */
const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 20_000;

/**
 * `Retry-After` in either of its two legal forms: seconds, or an HTTP date.
 *
 * Honoured rather than ignored because the server knows when its window
 * reopens and we are guessing. A value in the past clamps to zero; a garbage
 * value falls back to the computed backoff, since a header we cannot read is
 * not a reason to give up on the request.
 *
 * Parsed here, bounded at the call site: this returns what the server said.
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
 * One retry policy, not two.
 *
 * The status table alone cannot answer this: a 429 from a spent quota is a 429
 * every time for the rest of the month, and retrying it turns one billing
 * problem into `maxRetries` of them and a much later error message. Only the
 * body says which 429 this is, and `normalizeProviderError` is where that is
 * already read — so it is asked here rather than left to disagree with a table
 * after the retries have happened.
 *
 * It is a veto, not a second opinion: the table decides which statuses are
 * worth another attempt and the normalized verdict can only take one away.
 * That way a future change to the error mapping cannot start retrying 400s.
 */
function shouldRetry(status: number, error: ProviderHttpError): boolean {
  return isRetryableStatus(status) && normalizeProviderError(error).retryable;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
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
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxRetries = Math.max(0, options.maxRetries);

  /**
   * A backoff nobody can interrupt is a `stop()` that does not stop.
   *
   * The wait is where a retrying request spends nearly all of its time — up to
   * 20 seconds of it — and noticing the abort only at the top of the next
   * iteration means the run holds its state, and the user watches a cancelled
   * stream, for the rest of the window. So the sleep loses a race with the
   * signal, and the abort propagates like any other.
   */
  const wait = async (ms: number): Promise<void> => {
    const signal = options.signal;
    if (!signal) return await sleep(ms);
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        sleep(ms, signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

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
      // Checked before the attempt count, because this is not "no attempts
      // left" — it is "another attempt is the wrong thing to do". See
      // `RequestOptions.retryTimeouts`.
      if (timedOut && options.retryTimeouts === false) throw lastError;
      if (attempt === maxRetries) throw lastError;
      await wait(backoffDelayMs(attempt, random));
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

    if (attempt === maxRetries || !shouldRetry(response.status, error)) throw error;

    // Bounded, because `Retry-After` is a number the server chooses and a daily
    // quota answers it in hours. Sleeping through that holds the run open for
    // the whole window; waking early costs one request that gets the same 429
    // and a longer, still-bounded backoff after it.
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
    await wait(
      retryAfter === undefined
        ? backoffDelayMs(attempt, random)
        : Math.min(retryAfter, MAX_DELAY_MS),
    );
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
