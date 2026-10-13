import { describe, expect, test } from "vitest";

import {
  normalizeProviderError,
  ProviderHttpError,
  ProviderTimeoutError,
  retryAfterFromMessage,
} from "./errors";

function http(status: number, body: unknown) {
  return normalizeProviderError(new ProviderHttpError(status, body));
}

function openaiError(fields: Record<string, unknown>) {
  return { error: { type: "invalid_request_error", ...fields } };
}

describe("normalizeProviderError()", () => {
  test("a rate limit is retryable and says so", () => {
    const error = openaiError({ message: "Rate limit reached", code: "rate_limit_exceeded" });
    expect(http(429, error)).toEqual({
      code: "rate_limited",
      message: "Rate limit reached",
      retryable: true,
    });
  });

  /**
   * A spent quota answers 429 and will answer 429 all month. Marking it
   * retryable turns one billing problem into `maxRetries` of them and buries
   * the message that would have explained it.
   */
  test("a spent quota is a rate limit that is not worth retrying", () => {
    expect(
      http(
        429,
        openaiError({ message: "You exceeded your current quota", code: "insufficient_quota" }),
      ),
    ).toEqual({
      code: "rate_limited",
      message: "You exceeded your current quota",
      retryable: false,
    });
  });

  test("5xx is retryable, 4xx generally is not", () => {
    expect(http(503, "upstream unavailable")).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
    expect(http(401, openaiError({ message: "Incorrect API key" }))).toMatchObject({
      code: "provider_error",
      retryable: false,
    });
  });

  test("a too-long request is its own code, so an app can trim instead of retry", () => {
    expect(
      http(
        400,
        openaiError({
          code: "context_length_exceeded",
          message: "maximum context length is 128000 tokens",
        }),
      ),
    ).toMatchObject({ code: "context_length_exceeded", retryable: false });
  });

  test("Azure's content filter is read out of innererror, where it hides", () => {
    expect(
      http(400, {
        error: {
          code: "content_filter",
          message: "The response was filtered",
          innererror: { code: "ResponsibleAIPolicyViolation" },
        },
      }),
    ).toMatchObject({ code: "content_filtered", retryable: false });
  });

  /**
   * gpt-image-2's refusal, verbatim from Azure (nstfkc/gemi#938). It is the
   * same thing as a content filter to the app, which rewords on
   * `content_filtered`, and was reaching it as a generic `provider_error`.
   */
  test("an image model's moderation_blocked refusal is content_filtered", () => {
    expect(
      http(400, {
        error: {
          message:
            "Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID req_123. safety_violations=[sexual].",
          type: "image_generation_user_error",
          param: null,
          code: "moderation_blocked",
          moderation_details: { moderation_stage: "output", categories: ["sexual"] },
        },
      }),
    ).toMatchObject({ code: "content_filtered", retryable: false });
  });

  test("the safety system's wording alone is enough when the code is missing", () => {
    expect(
      http(400, openaiError({ message: "Your request was rejected by the safety system." })),
    ).toMatchObject({ code: "content_filtered", retryable: false });
  });

  /**
   * Azure's S0 rate limit ends with a link whose path is `quotaincrease`. That
   * is a suggestion, not a spent quota: the same message asks for a retry in
   * 30 seconds, and its code is `RateLimitReached`.
   */
  const AZURE_RATE_LIMIT =
    "Your requests to gpt-image-2 for gpt-image-2 in East US have exceeded the call rate limit for your current AIServices S0 pricing tier. This request was for ImageGenerations_Create under Azure OpenAI API version 2025-04-01-preview. Please retry after 30 seconds. To increase your default rate limit, visit: https://aka.ms/oai/quotaincrease.";

  test("Azure's rate-limit 429 is retryable, and carries the wait it asked for", () => {
    expect(http(429, { error: { code: "RateLimitReached", message: AZURE_RATE_LIMIT } })).toEqual({
      code: "rate_limited",
      message: AZURE_RATE_LIMIT,
      retryable: true,
      retryAfter: 30_000,
    });
  });

  test("a quotaincrease link alone does not make a 429 a spent quota", () => {
    expect(http(429, { error: { message: AZURE_RATE_LIMIT } })).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  test("a Retry-After header wins over the wait in the message", () => {
    const error = new ProviderHttpError(
      429,
      { error: { code: "RateLimitReached", message: AZURE_RATE_LIMIT } },
      undefined,
      12_000,
    );
    expect(normalizeProviderError(error)).toMatchObject({ retryable: true, retryAfter: 12_000 });
  });

  test("a quota that is spent in so many words is still not retried", () => {
    expect(
      http(429, {
        error: {
          code: "429",
          message: "Quota exceeded for this resource. See https://aka.ms/oai/quotaincrease",
        },
      }),
    ).toMatchObject({ code: "rate_limited", retryable: false });
  });

  test("retryAfterFromMessage() reads seconds and milliseconds, and nothing else", () => {
    expect(retryAfterFromMessage("Please retry after 30 seconds.")).toBe(30_000);
    expect(retryAfterFromMessage("retry after 1 second")).toBe(1000);
    expect(retryAfterFromMessage("Retry after 250ms")).toBe(250);
    expect(retryAfterFromMessage("Rate limit reached")).toBeUndefined();
  });

  test("a schema the API refused is reported as a tool problem", () => {
    expect(
      http(
        400,
        openaiError({
          message: "Invalid schema for function 'grep'",
          param: "tools[0].parameters",
        }),
      ),
    ).toMatchObject({ code: "invalid_tool_input", retryable: false });
  });

  test("an HTML error page from a proxy still normalizes", () => {
    expect(http(502, "<html>bad gateway</html>")).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });

  test("an abort is an abort, and never retried", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(normalizeProviderError(abort)).toEqual({
      code: "aborted",
      message: "The request was aborted.",
      retryable: false,
    });
  });

  test("a timeout is not an abort — the person did not stop anything", () => {
    expect(normalizeProviderError(new ProviderTimeoutError(1000))).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });

  test("a dropped socket is retryable", () => {
    expect(normalizeProviderError(new TypeError("fetch failed"))).toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });

  test("something that is not an error at all", () => {
    expect(normalizeProviderError("nope")).toEqual({
      code: "unknown",
      message: "nope",
      retryable: false,
    });
  });
});
