import { describe, expect, test } from "vitest";

import {
  normalizeProviderError,
  ProviderHttpError,
  ProviderTimeoutError,
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
