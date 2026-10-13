import type { AgentError } from "../types";

/**
 * A non-2xx response, carried as an exception so the retry loop and
 * `normalizeError` can both read it.
 *
 * The body is kept parsed-if-possible and raw-if-not: OpenAI and Azure both
 * answer `{ error: { message, type, code } }` on a good day, and an HTML error
 * page from a proxy on a bad one, and the bad day is exactly when the text
 * matters.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string;
  /** The response's `Retry-After`, in milliseconds, when it had one. */
  readonly retryAfter?: number;

  constructor(status: number, body: unknown, requestId?: string, retryAfter?: number) {
    super(`Provider request failed with status ${status}: ${describeBody(body)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/**
 * The request ran out of time. Its own class because it must not read as a
 * user abort: `stop()` means the person is done, and a timeout means the
 * network was, and only one of those is worth trying again.
 */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function describeBody(body: unknown): string {
  const detail = errorBody(body);
  if (detail?.message) return detail.message;
  if (typeof body === "string") return body.slice(0, 500);
  return "no error body";
}

type OpenAIErrorBody = { message?: string; type?: string; code?: string; param?: string };

function errorBody(body: unknown): OpenAIErrorBody | null {
  if (!body || typeof body !== "object") return null;
  const wrapper = body as { error?: unknown };
  const inner = wrapper.error && typeof wrapper.error === "object" ? wrapper.error : body;
  const e = inner as OpenAIErrorBody & { innererror?: { code?: string } };
  if (typeof e.message !== "string" && typeof e.code !== "string" && typeof e.type !== "string") {
    return null;
  }
  // Azure hides the interesting code one level down when its content filter
  // fires, and the outer code is the useless `content_filter`.
  const code = e.innererror?.code ?? e.code;
  return { message: e.message, type: e.type, code, param: e.param };
}

/**
 * The HTTP status and request id of a provider failure, read off what was
 * thrown — server-side detail for `AgentRunResult.error`, never for a frame.
 *
 * By shape rather than by `instanceof ProviderHttpError`, so a custom provider
 * whose SDK throws its own error class with a `status` gets the same detail.
 * A `status` outside 100–599 is not an HTTP status and is ignored.
 */
export function httpErrorDetail(error: unknown): { status?: number; requestId?: string } {
  if (!error || typeof error !== "object") return {};
  const { status, requestId } = error as { status?: unknown; requestId?: unknown };
  return {
    ...(typeof status === "number" && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof requestId === "string" && requestId ? { requestId } : {}),
  };
}

/**
 * Provider failures onto `AgentErrorCode`.
 *
 * The contract an app is buying here is that it can branch on `rate_limited`
 * without knowing whose rate limit it was, and on `retryable` without knowing
 * which of the two APIs answered. So `retryable` is set from what is actually
 * true of the failure — a 429 from a spent quota is not retryable no matter
 * what its status code says, and neither is a request that will be too long
 * again next time.
 */
export function normalizeProviderError(error: unknown): AgentError {
  if (error instanceof ProviderTimeoutError) {
    return { code: "provider_error", message: error.message, retryable: true };
  }

  if (isAbort(error)) {
    return { code: "aborted", message: "The request was aborted.", retryable: false };
  }

  if (error instanceof ProviderHttpError) {
    return fromStatus(error.status, errorBody(error.body), error.message, error.retryAfter);
  }

  // `fetch` rejects with a TypeError for DNS failures, refused connections and
  // dropped sockets. Every one of those is worth another attempt.
  if (error instanceof TypeError) {
    return {
      code: "provider_error",
      message: `Could not reach the provider: ${error.message}`,
      retryable: true,
    };
  }

  if (error instanceof Error) {
    return { code: "provider_error", message: error.message, retryable: false };
  }

  return { code: "unknown", message: String(error), retryable: false };
}

function fromStatus(
  status: number,
  body: OpenAIErrorBody | null,
  fallbackMessage: string,
  retryAfterHeader?: number,
): AgentError {
  const message = body?.message ?? fallbackMessage;
  const code = (body?.code ?? "").toLowerCase();
  const type = (body?.type ?? "").toLowerCase();
  // URLs are dropped before matching: Azure's ordinary rate-limit 429 ends
  // with "visit: https://aka.ms/oai/quotaincrease", and a link in a message is
  // advice, not the diagnosis.
  const haystack = `${code} ${type} ${message}`.toLowerCase().replace(/https?:\/\/\S+/g, "");

  if (status === 429) {
    // A spent quota answers 429 and will answer 429 for the rest of the month.
    // Retrying it is how a run turns one billing problem into `maxRetries`
    // billing problems and a much later error message. A code that names a
    // rate limit is believed over any wording, though: Azure's
    // `RateLimitReached` asks for a retry in so many seconds.
    const outOfCredit =
      !RATE_LIMIT_CODES.has(code) && (code === "insufficient_quota" || haystack.includes("quota"));
    if (outOfCredit) return { code: "rate_limited", message, retryable: false };
    const retryAfter = retryAfterHeader ?? retryAfterFromMessage(message);
    return {
      code: "rate_limited",
      message,
      retryable: true,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  if (status >= 500 || status === 408 || status === 409) {
    return { code: "provider_error", message, retryable: true };
  }

  if (isContextLength(haystack)) {
    return { code: "context_length_exceeded", message, retryable: false };
  }

  if (isContentFilter(haystack)) {
    return { code: "content_filtered", message, retryable: false };
  }

  // A schema the API refused. It is our request that is wrong, so the run
  // should surface it as a tool problem rather than a generic outage.
  if (body?.param?.startsWith("tools") || haystack.includes("invalid schema for function")) {
    return { code: "invalid_tool_input", message, retryable: false };
  }

  return { code: "provider_error", message, retryable: false };
}

/** Body codes that say "too many requests right now", never "out of credit". */
const RATE_LIMIT_CODES = new Set(["ratelimitreached", "rate_limit_exceeded", "too_many_requests"]);

/**
 * "Please retry after 30 seconds", as Azure words it in a 429 that may come
 * without a `Retry-After` header. Milliseconds, or undefined when the message
 * does not say.
 */
export function retryAfterFromMessage(message: string): number | undefined {
  const match = /retry after (\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)\b/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return /^m(s|illi)/i.test(match[2]!) ? value : value * 1000;
}

function isContextLength(haystack: string): boolean {
  return (
    haystack.includes("context_length_exceeded") ||
    haystack.includes("maximum context length") ||
    haystack.includes("context window") ||
    haystack.includes("reduce the length")
  );
}

function isContentFilter(haystack: string): boolean {
  return (
    haystack.includes("content_filter") ||
    haystack.includes("content_policy_violation") ||
    haystack.includes("responsibleaipolicyviolation") ||
    haystack.includes("content management policy") ||
    // The image models' refusal: `code: "moderation_blocked"`, "Your request
    // was rejected by the safety system ... safety_violations=[...]".
    haystack.includes("moderation_blocked") ||
    haystack.includes("rejected by the safety system") ||
    haystack.includes("safety_violations")
  );
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}
