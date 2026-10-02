import type { AgentError, AgentErrorCode } from "./types";

/**
 * A tool failure whose message is meant to be read: by the model, which can
 * act on it, and by the client, which shows it.
 *
 * Any other exception a tool throws reaches the model and the client as a
 * generic sentence (see `redactError`), because its message is whatever the
 * code underneath happened to say: a database driver's connection string, an
 * internal hostname, a third party's error body. The full error is logged.
 * Throw this instead when the message is written for the person:
 *
 * ```ts
 * if (!order) throw new ToolError(`There is no order ${input.orderId}.`);
 * ```
 */
export class ToolError extends Error {
  /** Whether the model may try the call again. Default `true`. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ToolError";
    this.retryable = options.retryable ?? true;
  }
}

/**
 * Where an error being redacted came from, with the unredacted detail.
 *
 * - `run`: the run's own failure, on its `error` frame. `failure` is what
 *   `result().error` returns: the provider's own message, its HTTP status and
 *   request id.
 * - `tool`: a tool threw. `cause` is what it threw; the result the model and
 *   the client read is the redacted one.
 */
export type ErrorRedactionInfo =
  | {
      source: "run";
      failure: AgentError & { status?: number; requestId?: string };
    }
  | {
      source: "tool";
      toolName: string;
      cause: unknown;
    };

/**
 * Decides what a client (and, for a tool, the model) is told about a failure.
 * Return the error to send. Full detail is never lost: it stays on
 * `result().error`, in the log and in the controller's `onError`.
 */
export type ErrorRedactor = (error: AgentError, info: ErrorRedactionInfo) => AgentError;

/**
 * The run failures whose message comes from outside gemi: a provider's error
 * body or an exception's text. Those can carry resource and deployment names,
 * internal URLs, request ids and, in a provider's validation message, pieces of
 * the request itself. The rest (`timeout`, `invalid_output`, `aborted`, ...)
 * are sentences gemi wrote and are kept.
 */
const GENERIC_RUN_MESSAGES: Partial<Record<AgentErrorCode, string>> = {
  provider_error: "The model provider returned an error.",
  rate_limited: "The model provider is rate limiting requests. Try again shortly.",
  context_length_exceeded: "The conversation is too long for the model.",
  content_filtered: "The model provider's content filter blocked this request.",
  invalid_tool_input: "The model provider rejected the request.",
  tool_error: "A tool failed.",
  unknown: "The run failed unexpectedly.",
};

/**
 * The default redaction, and what an override of `AgentController.redactError`
 * falls back to.
 *
 * Keeps `code`, `retryable` and `toolCallId`, which are what a client branches
 * on, and replaces a message that did not come from gemi with a fixed sentence
 * for its code. A tool's exception keeps its message only when it is a
 * `ToolError`.
 */
export function redactError(error: AgentError, info: ErrorRedactionInfo): AgentError {
  if (info.source === "tool") {
    if (info.cause instanceof ToolError) return error;
    return {
      ...error,
      message: `The tool "${info.toolName}" failed with an unexpected error.`,
    };
  }
  const generic = GENERIC_RUN_MESSAGES[error.code];
  return generic === undefined ? error : { ...error, message: generic };
}

/**
 * Runs an app's redactor and keeps only the `AgentError` fields of what it
 * returns, so a redactor that spreads the failure (`{ ...info.failure }`)
 * cannot put its status or request id on the wire by accident. A redactor
 * that throws falls back to the default rather than to the unredacted error.
 */
export function applyRedaction(
  redactor: ErrorRedactor | undefined,
  error: AgentError,
  info: ErrorRedactionInfo,
  onFailure: (err: unknown) => void,
): AgentError {
  let out: AgentError;
  try {
    out = (redactor ?? redactError)(error, info);
  } catch (err) {
    onFailure(err);
    out = redactError(error, info);
  }
  return {
    code: out.code,
    message: out.message,
    ...(out.toolCallId !== undefined ? { toolCallId: out.toolCallId } : {}),
    retryable: out.retryable,
  };
}

/**
 * The unredacted error behind a redacted one, for the server-side hooks.
 *
 * Keyed by the object put on the frame, which is the object the controller's
 * event hooks are handed in the same process; it never crosses a wire.
 */
const unredacted = new WeakMap<AgentError, AgentError>();

export function rememberUnredacted(redacted: AgentError, original: AgentError): void {
  if (redacted !== original) unredacted.set(redacted, original);
}

/** The original of `error` when it was redacted in this process, else `error`. */
export function unredactedError(error: AgentError): AgentError {
  return unredacted.get(error) ?? error;
}
