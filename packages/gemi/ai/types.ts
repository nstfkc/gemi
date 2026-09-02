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
  /** The run stopped because a tool call needs something only the client can
   *  give it. The conversation continues with an ordinary turn. */
  | "awaiting-input"
  | "aborted"
  | "error";

export type AgentErrorCode =
  | "provider_error"
  | "rate_limited"
  | "context_length_exceeded"
  | "content_filtered"
  | "tool_error"
  | "invalid_tool_input"
  /** A tool result came back for a call the server never made, or with a
   *  signature that does not verify. */
  | "invalid_tool_result"
  | "aborted"
  | "unknown";

export type AgentError = {
  code: AgentErrorCode;
  message: string;
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
    /**
     * The call did not run. `refused` is the client declining an approval or
     * answering something else instead; `stopped` is a cancel that landed while
     * the call was in flight.
     *
     * Both are told to the model rather than dropped, and for the same reason:
     * a history holding a tool call with no result is one the provider rejects,
     * so an abort has to leave a conversation that can still be continued. It
     * also happens to be true — the model asked for something and did not get
     * it, and the next turn goes better for knowing which.
     */
    | { status: "denied"; cause: "refused" | "stopped"; reason?: string }
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
  /** Stable and server-assigned, so a reattached stream does not duplicate
   *  messages the client already has. */
  id: string;
  role: "system" | "user" | "assistant";
  content: AgentContentPart<T, O>[];
  createdAt: string;
  /**
   * Absent until the message is complete; lets a UI show a cursor.
   *
   * `aborted` is a complete message too — a stopped turn keeps whatever it had
   * produced, marked as cut short. Dropping it would lose text the user already
   * read, and leave the model unable to tell that it was interrupted from that
   * it simply stopped talking.
   */
  finishReason?: FinishReason;
  usage?: Usage;
};

// --- what the client sends ----------------------------------------------

/**
 * A pending tool call: one the model made and the server will not complete on
 * its own.
 *
 * Three kinds, one mechanism. An approval is a tool the server can run but
 * won't without a human; a question is a tool whose whole answer is the human's;
 * a client tool is one only the browser can execute. They differ in who
 * produces the result, not in how the conversation carries it — which is why
 * none of them needs a second endpoint, and why adding client-executed tools
 * later costs no new protocol.
 */
export type PendingToolCall<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    toolCallId: string;
    name: K;
    input: T[K]["input"];
    kind: "approval" | "question" | "client";
    /**
     * Signs `runId + toolCallId + input` and is handed back untouched.
     *
     * In stateless mode the history lives in the browser, so without this the
     * client asserts not just *that* a call was approved but *what* was
     * approved — nothing would stop it from returning `approve: true` against
     * an input it rewrote on the way. The signature is what lets the pending
     * call travel through untrusted hands, and it is why approvals need no
     * server-side storage at all. Carries a nonce and an expiry, so a captured
     * one cannot be replayed into a later run.
     */
    signature: string;
  };
}[keyof T];

/** The client's half of a pending call. */
export type ClientToolResult =
  | { toolCallId: string; signature: string; approve: boolean; reason?: string }
  /** For `question` and `client` kinds: the value itself, checked against the
   *  tool's output schema before the model sees it. */
  | { toolCallId: string; signature: string; output: unknown };

/**
 * One turn from the client. Text, answers to pending calls, or both.
 *
 * A turn that leaves a pending call unanswered denies it: the provider rejects a
 * history with a dangling tool call, so *something* has to resolve it, and
 * treating "the user said something else" as a refusal is both the honest
 * reading and the one that cannot strand a conversation.
 *
 * Note what is absent: the client cannot author an assistant turn or invent a
 * tool result for a call that was never made. It sends its own words, its own
 * files, and answers to questions the server asked.
 */
export type ClientTurn = {
  text?: string;
  files?: { fileId: string; name?: string; mimeType?: string }[];
  toolResults?: ClientToolResult[];
};

// --- stream events -------------------------------------------------------

/**
 * One SSE frame each. Deltas are additive and never replay, so a client applies
 * them by appending; every event carries the ids needed to attach it to a
 * message without the client tracking "the current" anything, because an
 * attached stream starts mid-message.
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
   * Terminal for this stream: the run is finished, not parked. Everything
   * needed to answer is in the event and in the messages already delivered, so
   * the next turn is an ordinary send.
   */
  | { type: "awaiting-input"; runId: string; pending: PendingToolCall<T>[] }
  | { type: "message-end"; messageId: string; finishReason: FinishReason }
  | { type: "usage"; usage: Usage }
  /**
   * An error after the headers are flushed cannot be an HTTP status, so it is an
   * event. Pre-flight failures — auth, validation, an unknown agent — stay
   * ordinary HTTP errors and never reach this union.
   */
  | { type: "error"; error: AgentError }
  | { type: "run-end"; runId: string; finishReason: FinishReason };

/**
 * The event plus its position in the run.
 *
 * `seq` exists for reattachment: a client that dropped at 41 asks for 42 and
 * gets the tail rather than the whole run. It goes in the SSE `id:` field, so
 * the cursor is the transport's own and a client that reconnects with
 * `Last-Event-ID` is asking the right question by default.
 */
export type AgentStreamFrame<T extends ToolShapes = ToolShapes, O = unknown> = {
  seq: number;
  event: AgentStreamEvent<T, O>;
};
