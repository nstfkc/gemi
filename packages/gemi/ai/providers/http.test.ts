import { describe, expect, test } from "vitest";

import { ProviderHttpError, ProviderTimeoutError } from "./errors";
import {
  backoffDelayMs,
  MAX_DELAY_MS,
  parseRetryAfter,
  requestWithRetry,
  type FetchLike,
} from "./http";

/** Every delay is recorded instead of waited on, so the retry policy is
 *  asserted rather than timed. */
function harness(responses: (Response | Error)[]) {
  const slept: number[] = [];
  const calls: RequestInit[] = [];
  let i = 0;

  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };

  return {
    slept,
    calls,
    run: (maxRetries = 2) =>
      requestWithRetry(
        "https://api.example/responses",
        { method: "POST" },
        {
          maxRetries,
          timeoutMs: 0,
          fetchImpl,
          sleep: async (ms) => void slept.push(ms),
          random: () => 1,
          now: () => Date.parse("2026-01-01T00:00:00Z"),
        },
      ),
  };
}

function res(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

describe("parseRetryAfter()", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("seconds", () => expect(parseRetryAfter("3", now)).toBe(3000));
  test("fractional seconds", () => expect(parseRetryAfter("1.5", now)).toBe(1500));
  test("an HTTP date", () =>
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:20 GMT", now)).toBe(20_000));
  test("a date already past clamps to zero", () =>
    expect(parseRetryAfter("Thu, 01 Jan 2020 00:00:00 GMT", now)).toBe(0));
  test("a header we cannot read is not a reason to give up", () =>
    expect(parseRetryAfter("soon", now)).toBeUndefined());
  test("absent", () => expect(parseRetryAfter(null, now)).toBeUndefined());
});

describe("backoffDelayMs()", () => {
  test("doubles, and never exceeds the ceiling", () => {
    const full = (attempt: number) => backoffDelayMs(attempt, () => 1);
    expect([full(0), full(1), full(2)]).toEqual([500, 1000, 2000]);
    expect(full(20)).toBe(20_000);
  });

  test("jitter never collapses to zero, so a retry storm still spreads", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(250);
  });
});

describe("requestWithRetry()", () => {
  test("returns the first success without sleeping", async () => {
    const h = harness([res(200, "ok")]);
    expect((await h.run()).status).toBe(200);
    expect(h.slept).toEqual([]);
  });

  test("retries a 429 and honours Retry-After over the computed backoff", async () => {
    const h = harness([res(429, "{}", { "retry-after": "7" }), res(200, "ok")]);
    expect((await h.run()).status).toBe(200);
    expect(h.slept).toEqual([7000]);
  });

  test("falls back to exponential backoff when the server said nothing", async () => {
    const h = harness([res(500), res(500), res(200, "ok")]);
    await h.run();
    expect(h.slept).toEqual([500, 1000]);
  });

  test("gives up after maxRetries and throws the last response as an error", async () => {
    const h = harness([res(503, JSON.stringify({ error: { message: "down" } }))]);
    const error = await h.run(1).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(503);
    expect(h.calls).toHaveLength(2);
  });

  test("a 400 is not retried — the request will be just as wrong next time", async () => {
    const h = harness([res(400, "{}")]);
    await h.run().catch(() => {});
    expect(h.calls).toHaveLength(1);
  });

  /**
   * The one 429 that must not be retried. Only the body says which kind it is,
   * so a status table on its own gets this wrong — and gets it wrong three
   * times, on a card that is already declined, before reporting anything.
   */
  test("a spent quota is not retried, whatever its status code says", async () => {
    const quota = JSON.stringify({
      error: {
        code: "insufficient_quota",
        type: "insufficient_quota",
        message: "You exceeded your current quota, please check your plan and billing details.",
      },
    });
    const h = harness([res(429, quota)]);

    await h.run(2).catch(() => {});
    expect(h.calls).toHaveLength(1);
    expect(h.slept).toEqual([]);
  });

  test("a 429 that is only a rate limit is still retried", async () => {
    const h = harness([
      res(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } })),
      res(200, "ok"),
    ]);
    expect((await h.run()).status).toBe(200);
    expect(h.slept).toEqual([500]);
  });

  /**
   * A daily quota answers `Retry-After` in hours. Sitting through it holds the
   * run — and the user's cancelled stream — open for the whole window, so the
   * server's number is honoured only as far as the ceiling.
   */
  test("a Retry-After longer than the ceiling is clamped, not slept through", async () => {
    const h = harness([res(429, "{}", { "retry-after": "3600" }), res(200, "ok")]);
    await h.run();
    expect(h.slept).toEqual([MAX_DELAY_MS]);
  });

  /**
   * `stop()` means stop, and the backoff is where a retrying request spends
   * nearly all of its time. Deliberately driven with a sleep that ignores the
   * signal, because that is what an injected or third-party one does.
   */
  test("an abort during the backoff settles at once instead of finishing the wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    let calls = 0;

    const promise = requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 3,
        timeoutMs: 0,
        signal: controller.signal,
        fetchImpl: async () => {
          calls++;
          return res(503);
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        random: () => 1,
      },
    );

    setTimeout(() => controller.abort(), 20);
    const error = await promise.catch((e) => e);

    expect((error as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(400);
    expect(calls).toBe(1);
  });

  test("the default backoff is itself abortable", async () => {
    const controller = new AbortController();
    const started = Date.now();

    const promise = requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 3,
        timeoutMs: 0,
        signal: controller.signal,
        fetchImpl: async () => res(503),
        random: () => 1,
      },
    );

    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("a network failure is retried", async () => {
    const h = harness([new TypeError("fetch failed"), res(200, "ok")]);
    expect((await h.run()).status).toBe(200);
    expect(h.slept).toEqual([500]);
  });

  /** `stop()` means stop, not "stop and then try three more times". */
  test("the caller's abort is not retried", async () => {
    const controller = new AbortController();
    const abort = new Error("aborted");
    abort.name = "AbortError";
    let calls = 0;

    const promise = requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 3,
        timeoutMs: 0,
        signal: controller.signal,
        fetchImpl: async () => {
          calls++;
          controller.abort();
          throw abort;
        },
        sleep: async () => {},
      },
    );

    await expect(promise).rejects.toBe(abort);
    expect(calls).toBe(1);
  });

  test("a request that never answers times out, and the timeout is retried", async () => {
    const slept: number[] = [];
    let calls = 0;

    const response = await requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 1,
        timeoutMs: 5,
        fetchImpl: async (_url, init) => {
          if (calls++ === 0) {
            return await new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            });
          }
          return res(200, "ok");
        },
        sleep: async (ms) => void slept.push(ms),
        random: () => 1,
      },
    );

    expect(response.status).toBe(200);
    expect(slept).toEqual([500]);
  });

  test("a timeout that survives every attempt surfaces as a timeout, not an abort", async () => {
    const error = await requestWithRetry(
      "https://api.example/responses",
      { method: "POST" },
      {
        maxRetries: 0,
        timeoutMs: 5,
        fetchImpl: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
        sleep: async () => {},
      },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderTimeoutError);
  });
});
