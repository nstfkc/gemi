// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.

/**
 * The message and event model.
 *
 * This file is the actual public contract of the module. `AgentMessage` is what
 * an app persists and what `useChat` renders, and `AgentStreamEvent` is what
 * goes over the wire — so both are defined provider-agnostically here rather
 * than in the OpenAI provider, and the provider's job is to translate into
 * them. Anthropic or a local model can be added later by writing one translator
 * instead of by changing what an app sees.
 */

/**
 * Tools reduced to just their payload types.
 *
 * The client needs `{ bash: { input: { command: string }, output: ... } }` to
 * discriminate a tool part by name, but it must not need `execute` — that is
 * server code. Erasing tools to this shape at the Agent boundary is what keeps
 * a tool's implementation out of the browser bundle while its types survive.
 */
export type ToolShape = { input: unknown; output: unknown };
export type ToolShapes = Record<string, ToolShape>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** Billed separately by OpenAI and worth surfacing on its own. */
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens: number;
};

export type FinishReason =
  | "stop"
  | "length"
  /** `maxSteps` was hit. A run that ends this way is not an error, and it is
   *  also not a finished answer — the UI has to be able to tell them apart. */
  | "max-steps"
  /** The run stopped because a tool needs a human. Resumable. */
  | "awaiting-approval"
  | "aborted"
  | "error";

export type AgentErrorCode =
  | "provider_error"
  | "rate_limited"
  | "context_length_exceeded"
  | "content_filtered"
  | "tool_error"
  | "invalid_tool_input"
  | "aborted"
  | "unknown";

export type AgentError = {
  code: AgentErrorCode;
  message: string;
  /** Present for `tool_error` / `invalid_tool_input`. */
  toolCallId?: string;
  retryable: boolean;
};

// --- content parts -------------------------------------------------------

export type TextPart = { type: "text"; text: string };

/**
 * Reasoning is kept as its own part rather than folded into text: it must be
 * renderable separately (or not at all), and on the next turn it has to be sent
 * back to the provider in its original form for cache hits to survive.
 */
export type ReasoningPart = { type: "reasoning"; id?: string; text?: string };

/** An uploaded file, referenced by the id `provider.upload()` returned. */
export type FilePart = {
  type: "file";
  fileId: string;
  name?: string;
  mimeType?: string;
};

export type ToolCallPart<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    type: "tool-call";
    toolCallId: string;
    name: K;
    input: T[K]["input"];
    /** Set while the model is still streaming the arguments. */
    partial?: boolean;
  };
}[keyof T];

export type ToolResultPart<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    type: "tool-result";
    toolCallId: string;
    name: K;
  } & (
    | { status: "ok"; output: T[K]["output"] }
    | { status: "error"; error: AgentError }
    /** Approval was requested and refused; the model is told so it can adapt. */
    | { status: "denied"; reason?: string }
  );
}[keyof T];

/** The final answer when the agent declares an `output` schema. */
export type OutputPart<O = unknown> = {
  type: "output";
  value: O;
  /** True while the object is still being assembled from the token stream. */
  partial?: boolean;
};

export type AgentContentPart<T extends ToolShapes = ToolShapes, O = unknown> =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolCallPart<T>
  | ToolResultPart<T>
  | OutputPart<O>;

export type AgentMessage<T extends ToolShapes = ToolShapes, O = unknown> = {
  /** Stable and server-assigned, so a resumed run does not duplicate messages. */
  id: string;
  role: "system" | "user" | "assistant";
  content: AgentContentPart<T, O>[];
  createdAt: string;
  /** Absent until the message is complete; lets a UI show a cursor. */
  finishReason?: FinishReason;
  usage?: Usage;
};

/** What the client is allowed to send. A client cannot fabricate an assistant
 *  turn or a tool result: the server owns everything except the user's own words
 *  and files. */
export type UserMessageInput = {
  text: string;
  files?: { fileId: string; name?: string; mimeType?: string }[];
};

// --- stream events -------------------------------------------------------

/**
 * One SSE frame each. Deltas are additive and never replay, so a client applies
 * them by appending; every event carries the ids needed to attach it to a
 * message without the client tracking "the current" anything, because a resumed
 * stream starts mid-message.
 */
export type AgentStreamEvent<T extends ToolShapes = ToolShapes, O = unknown> =
  | { type: "run-start"; runId: string; threadId?: string }
  | { type: "message-start"; messageId: string; role: "assistant" }
  | { type: "text-delta"; messageId: string; delta: string }
  | { type: "reasoning-delta"; messageId: string; delta: string }
  /** Emitted only for an agent with an `output` schema: `delta` is raw JSON
   *  text, `snapshot` the best-effort parse so far, so a UI can bind fields
   *  before the object closes. */
  | { type: "output-delta"; messageId: string; delta: string; snapshot: Partial<O> }
  | { type: "tool-call"; messageId: string; part: ToolCallPart<T> }
  /** From a tool whose `execute` is an AsyncGenerator. */
  | { type: "tool-progress"; toolCallId: string; data: unknown }
  | { type: "tool-result"; messageId: string; part: ToolResultPart<T> }
  /**
   * Terminal for this stream. The run is parked; the client answers on the
   * resume route and gets a fresh stream that continues it.
   */
  | {
      type: "approval-required";
      runId: string;
      approvals: { toolCallId: string; name: keyof T & string; input: unknown }[];
    }
  | { type: "message-end"; messageId: string; finishReason: FinishReason }
  | { type: "usage"; usage: Usage }
  /**
   * An error after the headers are flushed cannot be an HTTP status, so it is an
   * event. Pre-flight failures — auth, validation, an unknown agent — stay
   * ordinary HTTP errors and never reach this union.
   */
  | { type: "error"; error: AgentError }
  | { type: "run-end"; runId: string; finishReason: FinishReason };
