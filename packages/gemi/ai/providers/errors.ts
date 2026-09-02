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

  constructor(status: number, body: unknown, requestId?: string) {
    super(`Provider request failed with status ${status}: ${describeBody(body)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
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
    return fromStatus(error.status, errorBody(error.body), error.message);
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
): AgentError {
  const message = body?.message ?? fallbackMessage;
  const code = (body?.code ?? "").toLowerCase();
  const type = (body?.type ?? "").toLowerCase();
  const haystack = `${code} ${type} ${message}`.toLowerCase();

  if (status === 429) {
    // A spent quota answers 429 and will answer 429 for the rest of the month.
    // Retrying it is how a run turns one billing problem into `maxRetries`
    // billing problems and a much later error message.
    const outOfCredit = code === "insufficient_quota" || haystack.includes("quota");
    return { code: "rate_limited", message, retryable: !outOfCredit };
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
    haystack.includes("content management policy")
  );
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}
