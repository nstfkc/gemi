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

import type { ToolAttachmentRecord } from "./store/Attachments";

/**
 * Tools reduced to just their payload types.
 *
 * The client needs `{ bash: { input: { command: string }, output: ... } }` to
 * discriminate a tool part by name, but it must not need `execute` — that is
 * server code. Erasing tools to this shape at the Agent boundary is what keeps
 * a tool's implementation out of the browser bundle while its types survive.
 *
 * `progress` is whatever a generator tool yields on its way to that output.
 * Optional here on purpose: `ToolShapesOf` always emits it — `never` for a tool
 * that cannot yield — but a `ToolShapes` written by hand before this field
 * existed is still a valid one, and every `T[K]["progress"]` below resolves for
 * it rather than failing to compile. That is why this is a third member of the
 * existing type and not a second type beside it.
 */
export type ToolShape = { input: unknown; output: unknown; progress?: unknown };
export type ToolShapes = Record<string, ToolShape>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** Billed separately by OpenAI and worth surfacing on its own. */
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /**
   * How much of `inputTokens` / `outputTokens` was image rather than text, on a
   * generation or an edit.
   *
   * A BREAKDOWN, NOT A SEPARATE BUCKET — the same relationship `reasoningTokens`
   * has to `outputTokens` and `cachedInputTokens` has to `inputTokens`. This was
   * worth getting right rather than assuming: the design note for this field
   * argued they should be kept *out* of the totals so nothing could price image
   * tokens at a text rate, and the measurement says the vendor does not work
   * that way. An edit reports `input_tokens: 1038` with
   * `input_tokens_details: { image_tokens: 1024, text_tokens: 14 }` — 1038 is
   * the sum, not the text half. Subtracting here to invent a separate bucket
   * would produce a `totalTokens` that disagrees with the provider's own.
   *
   * So the totals stay the provider's, and these say what they are made of. A
   * caller pricing a run can subtract; a caller that does not care is unaffected.
   *
   * MEASURED, `gpt-image-2` on Azure: a generation reports `image_tokens: 0` on
   * the input side and all of `outputTokens` as image — 196 at `low`/1024², 5488
   * at `high`/1536x1024. An edit reports 1024 input image tokens per 1024x1024
   * input image, and 2048 for two.
   *
   * Absent on usage from a text call, exactly like `reasoningTokens`.
   */
  imageInputTokens?: number;
  imageOutputTokens?: number;
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
  | "error"
  /**
   * The message's run died before it finished it: a restart, a crash, a
   * deploy. Never on a live frame — no run is left to send one. It is set on a
   * message the store kept from a run that is no longer live, when the thread
   * is read (`AgentController.readThread`) or when the next turn starts, and a
   * tool call the message left open gets a `denied` result with
   * `cause: "interrupted"`. See `AgentMessage.runId`.
   */
  | "interrupted";

export type AgentErrorCode =
  | "provider_error"
  | "rate_limited"
  | "context_length_exceeded"
  | "content_filtered"
  | "tool_error"
  | "invalid_tool_input"
  /** The model's structured answer did not match the `output` schema, or never
   *  finished — from `generate`, or from an agent's final turn. The message
   *  says what was wrong, worded to be handed back to the model on a retry. */
  | "invalid_output"
  /** A tool result came back for a call the server never made, or with a
   *  signature that does not verify. */
  | "invalid_tool_result"
  /** The `threadId` names a thread the server's store does not have: expired,
   *  mistyped, or on an instance that is gone. Answered before anything runs;
   *  the app starts a new thread or continues stateless. */
  | "thread_not_found"
  /** A time limit ran out: the run's `maxRunDurationMs` (on the run's
   *  `error`), or a tool's `timeoutMs` (on that call's `tool-result`, with
   *  `toolCallId` set, and the run carries on). */
  | "timeout"
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

/**
 * An uploaded file: the provider's copy, gemi's copy, or both.
 *
 * At least one of `fileId` and `attachmentId` is present, and which ones are is
 * the upload's destination — `provider` has only a `fileId`, `storage` only an
 * `attachmentId`, `both` both. Not expressed as a union because every producer
 * already holds the two as optionals (`attach()`, the upload answer) and the
 * one shape with neither is refused at the door (`toClientTurn`) and again on
 * the way out (`toResponsesInput`).
 */
export type FilePart = {
  type: "file";
  /**
   * The **provider's** file id, and only ever that. It is what the model is
   * shown so it can look at the file, and its meaning did not change when gemi
   * started keeping copies of uploads: `POST /chat/files` answers `fileId` for
   * this field and a separate `attachmentId` for tools. They are two ids for two
   * systems. A gemi attachment id put here is caught by `toResponsesInput` with
   * a message saying so, rather than reaching the vendor as an unknown file.
   *
   * Absent for an upload routed to storage only: the provider never saw it, so
   * the model is told the file exists (by `attachmentId`) and is not shown it.
   */
  fileId?: string;
  name?: string;
  mimeType?: string;
  /**
   * gemi's attachment id — the handle a tool resolves through
   * `ctx.attachments`. A user's upload carries it when the upload was kept (see
   * `ClientTurn.files`), and the run sets it on a file part it injected itself
   * for `ctx.attachments.put(blob, { showModel: true })`.
   *
   * It IS sent to the provider, as a line of text beside the file, so the model
   * has an id to put in a tool's arguments instead of inventing one. That line
   * is rendered when the request is built (`toResponsesInput`), not stored here
   * as a text part, so the transcript stays structured and the wording can
   * change without rewriting anybody's history.
   *
   * It is NOT the marker for "a tool made this". A user's own upload carries one
   * too, so the run's context pruning keys on the injected message's id, which
   * the tool call's `attachments` record names. See `historyForProvider` in
   * `Agent.ts`.
   */
  attachmentId?: string;
  /**
   * Set by the run when the provider refused `fileId` (a deleted or expired
   * file, an id from the wrong upload purpose, #684). From then on the request
   * carries a line saying the attachment could not be read instead of the id,
   * so one bad file costs one turn a retry rather than failing every turn of
   * the thread. `fileId` is kept, as the record of what was refused; a UI can
   * use the flag to show the file as unreadable.
   */
  providerRejected?: true;
};

/**
 * A sub-agent's run, recorded on the tool call that drove it.
 *
 * `messages` is an ordinary transcript, and that is the entire design: a nested
 * run renders with the same reducer and the same components as the outer one,
 * so arbitrary depth costs the client nothing and costs this file one type. It
 * is also what makes resumption possible — a tool that escalated a question is
 * re-entered from the top on the next turn and replays its finished sub-runs
 * out of exactly this, which is why the transcript is persisted on the message
 * instead of held in memory beside the run.
 *
 * The sub-run's tools are the sub-agent's, not the parent's, so `messages` is
 * left at the default `ToolShapes`. A parent's tool shapes say nothing about
 * what its children can call, and pretending otherwise would type a nested
 * transcript with the wrong tool names.
 */
export type NestedRun = {
  runId: string;
  /** The sub-agent's name, so the UI has something to label the block with. */
  agent: string;
  /** Caller-supplied, e.g. "researching pricing". */
  label?: string;
  messages: AgentMessage[];
  finishReason?: FinishReason;
  usage?: Usage;
  /**
   * Present on a record whose sub-run is parked `awaiting-input`, and handed
   * back untouched like a pending call's.
   *
   * The next turn re-enters — runs — the tool this record hangs off because
   * the record says a sub-run under it is waiting on the question being
   * answered. In stateless mode the record arrives from the browser, so
   * without this it is the client deciding which tools run. Signed by the
   * server over where the sub-run parked and which calls it left open; see
   * `signing.ts`.
   */
  signature?: string;
};

export type ToolCallPart<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    type: "tool-call";
    toolCallId: string;
    name: K;
    input: T[K]["input"];
    /** Set while the model is still streaming the arguments. */
    partial?: boolean;
    /**
     * Everything this tool yielded, in order, typed by the tool's own progress
     * type.
     *
     * Append-only and never rewritten, which is what lets the client apply a
     * `tool-progress` frame by pushing and lean on `seq` for redelivery — the
     * same bargain every other additive event in this file makes. Absent until
     * the first yield, so a tool that never yields adds no field.
     */
    progress?: T[K]["progress"][];
    /**
     * Sub-agent runs this tool drove, in the order they started.
     *
     * In stateless mode this is client-carried and therefore client-editable,
     * and that is not a new hole: the entire parent history is client-carried
     * in stateless mode already. The thing that must be unforgeable is the
     * approval *decision*, and that is what the signature on a `PendingToolCall`
     * covers — a rewritten nested transcript cannot manufacture consent for a
     * call the server never made.
     */
    nested?: NestedRun[];
    /**
     * Attachments this tool call parked, in the order it parked them.
     *
     * The memo for `ctx.attachments.put`, and it lives here for the reason
     * `nested` does: a tool that escalates is re-entered from the top on the
     * next turn, the message history is the only state that crosses that
     * boundary, and a `put` with no record would store the bytes again, upload
     * them again and show the model the same image twice. Indexed by the order
     * of the `put` calls within the tool call — the same key `runAgent` uses,
     * with the same caveat about a body whose calls sit in a branch.
     *
     * Absent until the first `put` that produced something, so a tool that
     * attaches nothing — including one whose every `put` threw — adds no field
     * to the wire or the store. A `put` that threw with a later one that did not
     * leaves `{ failed: true }` at its index rather than a hole, because a hole
     * is `null` after JSON and this list is walked by index; see
     * `ToolAttachmentRecord`.
     */
    attachments?: ToolAttachmentRecord[];
    /**
     * The `ToolNamespace` the model called this tool through, as the provider
     * reported it (`{name: "getOrder", namespace: "crm"}`). Absent for a tool
     * that was listed bare, and on a provider without tool search.
     *
     * Provenance, not identity: `name` is still the registry key. It is kept
     * because the provider needs it back (#776). A namespaced call replayed
     * without it is a call to a top-level function the model's tools do not
     * list, and after one of those the model went off the rails on every
     * later step.
     */
    namespace?: string;
    /**
     * The tool searches the model ran in this step before making this call,
     * in order. Only on the first call after a search, absent everywhere else.
     *
     * Kept so the next request can replay them (#776): a deferred tool is only
     * loaded for the model through a search in its history, and a history
     * holding a call to a deferred tool and no search that loaded it is not
     * one the model wrote. On the call rather than as a part of its own
     * because the content part union is a frozen contract that every client
     * switches on. A search that no call followed is not kept; it changed
     * nothing the model then did.
     */
    toolSearches?: ToolSearchRecord[];
  };
}[keyof T];

/**
 * One tool search the model ran, as stored on the `ToolCallPart` after it.
 *
 * `namespaces` and `loaded` are what it found (as on the `tool-search`
 * provider event), and `arguments` is the query it sent, as the provider
 * reported it (`{paths: ["crm"]}` on the Responses API). The search's output
 * is not stored: it is the schemas of the tools named here, and the provider
 * rebuilds it from the agent's current tools when it replays the search. That
 * keeps a transcript from carrying whole schemas around, and means a history
 * never tells the model about a tool the agent no longer has.
 */
export type ToolSearchRecord = {
  namespaces: string[];
  loaded: string[];
  arguments?: unknown;
};

/**
 * One value a tool yielded, as `useChat`'s `onToolProgress` hands it over.
 *
 * NOT A CONTENT PART — nothing in a transcript has this shape. A tool's yields
 * live as the `progress` array on its `ToolCallPart`; this is the single value
 * that was just appended to one, carrying the call it belongs to and the tool's
 * name so that `name === "buildPage"` narrows `data` to what *that* tool
 * yields. The name is not on the `tool-progress` frame, which carries only an
 * id and an opaque value — the hook reads it off the part the value landed on,
 * which is also why a frame for a call the client does not have announces
 * nothing.
 *
 * `data` is `never` for a tool whose `execute` returns a promise rather than
 * yielding. That is the honest answer — such a tool cannot produce progress —
 * and it is what makes the narrowing worth having over an `unknown` the app
 * would cast.
 *
 * It lives here rather than beside `useChat` so that the name is reachable from
 * both halves of the module, like every other shape the two ends share.
 */
export type ToolProgress<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    toolCallId: string;
    name: K;
    data: T[K]["progress"];
  };
}[keyof T];

/**
 * The background job behind a tool result (#461): on a `running` result, and
 * kept on the `ok` or `error` result it settled into.
 */
export type AgentJobRef = {
  /** `ajob_…`, the job store's id. */
  id: string;
  /** What the tool said about the job when it started it. */
  summary?: unknown;
  /**
   * What the job spent on model and image calls, once it has settled. Part of
   * the cost of the turn that started it, which had already ended.
   */
  usage?: Usage;
};

export type ToolResultPart<T extends ToolShapes = ToolShapes> = {
  [K in keyof T]: {
    type: "tool-result";
    toolCallId: string;
    name: K;
  } & (
    | { status: "ok"; output: T[K]["output"]; job?: AgentJobRef }
    | { status: "error"; error: AgentError; job?: AgentJobRef }
    /**
     * The tool started a background job (it returned a `JobHandle`) and the
     * job has not settled yet (#461). Not a pause: the turn goes on and ends
     * as usual, and the thread takes new turns meanwhile. When the job
     * settles, this result becomes `ok` or `error` in place, the next time the
     * controller loads the thread. Only on a threaded conversation.
     */
    | { status: "running"; job: AgentJobRef }
    /**
     * The call did not run. `refused` is the client declining an approval or
     * answering something else instead; `stopped` is a cancel that landed while
     * the call was in flight.
     *
     * `interrupted` is a call whose run died while it was in flight (see
     * `FinishReason`). Unlike `stopped` it may have run, in part or in full:
     * nobody was left to record its result, not to stop it.
     *
     * All three are told to the model rather than dropped, and for the same reason:
     * a history holding a tool call with no result is one the provider rejects,
     * so an abort has to leave a conversation that can still be continued. It
     * also happens to be true — the model asked for something and did not get
     * it, and the next turn goes better for knowing which.
     */
    | { status: "denied"; cause: "refused" | "stopped" | "interrupted"; reason?: string }
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
  /**
   * The model ran out of output budget on this message: the provider stopped it
   * at `length`, whether that was the cap the app set or the model's own.
   *
   * Set for any agent, not only one with an `output` schema — an agent that just
   * writes text is cut short the same way, and this is the flag to render "the
   * answer was cut short" from either way. For an agent that *does* declare an
   * `output` schema it also means there is no `output` part and never will be.
   *
   * Kept on the message rather than only used to drop the part, because dropping
   * it alone left a UI unable to tell "cut off" from "no structured answer here" —
   * and `finishReason` cannot say it: a step that hits the ceiling while also
   * calling a tool closes its message `awaiting-input` or `max-steps`.
   */
  outputTruncated?: true;
  /**
   * What the model call that wrote this assistant message cost — that step
   * alone, not the turn (#467). A run of three steps has three messages, each
   * with its own. Tools' spending (sub-runs, `generate()`, images) is in the
   * run total — `result().usage` and the `usage` frame — and a sub-run's own
   * total is on its `NestedRun`. Absent on user messages and on a message whose
   * call never reported usage (aborted mid-stream).
   */
  usage?: Usage;
  /**
   * The run writing this message, on a copy the controller stored while the
   * run was still going: a threaded turn is written to the store as it runs
   * (the user's message, then each assistant message from its start), so a
   * restart mid-run leaves the turn behind instead of nothing.
   *
   * Only on a message with no `finishReason`, plus the `interrupted` one it may
   * become. The finished message replaces it by id and does not carry it. It is
   * how a reader tells "still being written" from "its run is gone": the
   * controller asks whether this run is live (`isRunLive`), and marks the
   * message `interrupted` when it is not.
   */
  runId?: string;
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
    /**
     * The chain of tool-call ids this call is nested under, outermost first.
     * Absent at the top level, which is every call today.
     *
     * A sub-agent's question reaches the user through its *parent's* pending
     * list, so `toolCallId` alone stops being an address: two sub-runs under
     * two different tools can each hold a call the parent never made, and the
     * turn that answers has to say which tool to re-enter. The path is that
     * address, and it is inside the signature rather than beside it — a token
     * minted for a call nested under tool call X cannot be replayed as a
     * top-level call, or as one nested under Y.
     *
     * The client hands it back untouched, exactly like the signature, so an app
     * answering a sub-agent's question writes what it writes for any other one.
     */
    path?: string[];
  };
}[keyof T];

/**
 * The client's half of a pending call.
 *
 * `path` is the `PendingToolCall`'s, returned unchanged. It has to come back
 * rather than be looked up because the signature commits to it without
 * carrying it in the clear — verification recomputes the MAC over the claims it
 * is handed, so the server needs the path in front of it to check that the
 * client did not move the answer to a different tool call.
 *
 * Returning a path the server did not issue therefore fails verification rather
 * than redirecting anything, which is the property that makes it safe to let
 * the client carry it at all.
 */
export type ClientToolResult =
  | {
      toolCallId: string;
      signature: string;
      path?: string[];
      approve: boolean;
      reason?: string;
    }
  /** For `question` and `client` kinds: the value itself, checked against the
   *  tool's output schema before the model sees it. */
  | { toolCallId: string; signature: string; path?: string[]; output: unknown };

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
  /**
   * The id the client gave its own copy of this turn's message — the one it
   * shows while the run is under way (#466). The server does not take it as the
   * message's id: it mints its own, and answers with a `message-id` event
   * naming both, so the client can rename its copy to the id the store and
   * every later load use. A client-chosen id is never stored, because a store
   * keyed by message id across threads would let a client that names someone
   * else's id write over their message. Ignored on a turn that adds no message
   * (answers only).
   */
  localId?: string;
  /**
   * What `attach()` answered, passed on whole: `fileId` for the model to look
   * at, `attachmentId` for a tool to be handed. Either may be absent (see
   * `FilePart`), never both. The server checks the shape before anything runs,
   * because an entry that is wrong here is stored in the thread and fails every
   * later turn, not just this one.
   */
  files?: { fileId?: string; attachmentId?: string; name?: string; mimeType?: string }[];
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
  /**
   * `id` is the provider's own reasoning-item id, and it is carried for one
   * reason: a stateless client posts its `messages` back verbatim, and
   * `providers/request.ts` drops a reasoning item that has no id on purpose —
   * a fabricated one "would look like continuity that is not there". Without
   * the id here the server records it and the browser does not, so a stateless
   * app silently re-derives its reasoning every step and misses the prompt
   * cache, which keys on the literal item. Optional because a provider need
   * not supply one (Azure does not always); such a part still renders, it just
   * cannot be echoed back.
   */
  | { type: "reasoning-delta"; messageId: string; delta: string; id?: string }
  /** Emitted only for an agent with an `output` schema: `delta` is raw JSON
   *  text, `snapshot` the best-effort parse so far, so a UI can bind fields
   *  before the object closes. */
  | { type: "output-delta"; messageId: string; delta: string; snapshot: Partial<O> }
  | {
      type: "tool-call";
      messageId: string;
      part: ToolCallPart<T>;
      /**
       * The server sending a call the client already holds, to put its own
       * copy of the part in the client's hands — a parked sub-run's signed
       * record, which the client cannot build from the forwarded events. Not
       * a new call: the reducer merges it like any other frame, and a hook
       * that fires per call skips it, because on a re-park the call it names
       * was made by a previous run altogether.
       */
      resent?: true;
    }
  /** The model searched for deferred tools and loaded these. A UI can say "…
   *  looking for the right tool" instead of showing an unexplained pause. */
  | { type: "tool-search"; loaded: string[] }
  /** From a tool whose `execute` is an AsyncGenerator. */
  | { type: "tool-progress"; toolCallId: string; data: unknown }
  /**
   * One event from a sub-agent, re-emitted on the parent stream.
   *
   * Its own event rather than a shape of `tool-progress` because the client
   * does something categorically different with it: `tool-progress` appends an
   * opaque datum to an array, while this is applied RECURSIVELY by the same
   * reducer to the nested run's own message list. That recursion is the trick —
   * a nested transcript is built by the code that already builds a transcript,
   * which is why depth costs the client nothing and why overloading
   * `tool-progress` would have cost it a second renderer.
   *
   * Numbered in the parent's `seq` like everything else, so `/attach` replay
   * and the frame buffer stay correct through the nesting. `event` is left at
   * the default `ToolShapes` for the same reason `NestedRun.messages` is: the
   * sub-agent's tools are not the parent's.
   */
  | {
      type: "nested-event";
      /** The parent tool call the sub-run belongs to. */
      toolCallId: string;
      runId: string;
      agent: string;
      label?: string;
      event: AgentStreamEvent;
    }
  | { type: "tool-result"; messageId: string; part: ToolResultPart<T> }
  /**
   * A complete message the run wrote that nobody typed.
   *
   * Today there is exactly one: the input-role message carrying a file a tool
   * produced with `showModel`. It needs an event because the client cannot
   * derive it from anything else on the stream — the user's own turn needs no
   * event precisely because the client already has it, and this is the opposite
   * case: content appears in the middle of an answer that no client authored,
   * and a live watcher that never heard about it renders a conversation the
   * server does not have.
   *
   * WHOLE, NOT STREAMED, and that is the honest shape rather than a shortcut.
   * `message-start` / deltas / `message-end` exist because an assistant message
   * arrives a token at a time; this one is finished the instant it is made, so
   * there is nothing to open and nothing to close, and splitting it into three
   * frames would invent two states it is never in. It also makes redelivery
   * free: the reducer replaces by id with a value that cannot have changed,
   * which is the one case where the wholesale replace `tool-call` warns against
   * is safe — the server is the sole author and the message is immutable.
   */
  | { type: "message"; message: AgentMessage<T, O> }
  /**
   * The id the server gave the user's own message, for the client that sent it
   * (#466). Only on a top-level turn whose `ClientTurn` carried a `localId`,
   * right after the run stored the message.
   *
   * The turn itself is not echoed: the client already holds it, and an echo
   * would show the question twice on any client that does not reconcile the
   * two. What it lacks is the id, and without it the copy it shows never
   * matches the stored one — a reload changes the React key, anything the app
   * keyed on the id (reactions, edits, citations) is lost, and a stateless
   * client posts back a message the server never wrote. So the reducer renames
   * its `localId` message to `messageId`, and a client that never sent a
   * `localId` gets nothing. A sub-run's user turn is not the client's and comes
   * whole, as `message`.
   *
   * `message` is the stored turn itself (#778), for every OTHER client watching
   * the run: a second tab on the same thread that attached with `reattach()`
   * never held the `localId` copy, and without it would show the answer under
   * no question. The reducer appends it only when nothing is under `localId` and
   * nothing is under `messageId` yet, so the client that sent the turn renames
   * its copy exactly as before and never shows it twice. Optional, because a
   * server older than #778 does not send it.
   */
  | { type: "message-id"; localId: string; messageId: string; message?: AgentMessage<T, O> }
  /**
   * Terminal for this stream: the run is finished, not parked. Everything
   * needed to answer is in the event and in the messages already delivered, so
   * the next turn is an ordinary send.
   */
  | { type: "awaiting-input"; runId: string; pending: PendingToolCall<T>[] }
  /**
   * `outputTruncated` says the model ran out of output budget on this message —
   * the provider stopped it at `length` — whatever the message's finish reason
   * turned out to be, and whether or not the agent declares an `output` schema.
   *
   * It needs its own field because `finishReason` cannot carry it: a step that
   * hits the ceiling *and* calls a tool ends the message `awaiting-input` or
   * `max-steps`, and both of those are load-bearing for the UI. The client uses
   * this to drop the partial `output` part rather than complete it — the server
   * withholds its own for the same reason, and the two must not disagree.
   */
  | {
      type: "message-end";
      messageId: string;
      finishReason: FinishReason;
      outputTruncated?: true;
      /**
       * What the model call that wrote this message cost, and only it (#467).
       * The same value as `AgentMessage.usage`. Absent when the provider never
       * reported usage for the call (it was aborted mid-stream).
       */
      usage?: Usage;
    }
  /**
   * The whole turn's usage so far: every step's model call plus what tools
   * spent through sub-runs, `generate()` and image calls. Not any one message's
   * — that is on `message-end` and `AgentMessage.usage`.
   */
  | { type: "usage"; usage: Usage }
  /**
   * An error after the headers are flushed cannot be an HTTP status, so it is an
   * event. Pre-flight failures — auth, validation, an unknown agent — stay
   * ordinary HTTP errors and never reach this union.
   *
   * `nested` is set when the error is a sub-run's, re-raised on this stream
   * (#468), right after the `nested-event` that carries the original. This
   * copy is what the parent's `useChat.error` and the `onError` hooks see;
   * the wrapped one alone reached none of them. It is not
   * terminal: the parent run goes on, and the tool that started the sub-run
   * decides what its failure means (it gets it on `NestedRunResult.error`).
   * `toolCallId` is the parent's tool call the sub-run hangs off, `runId` and
   * `agent` the sub-run's. A failure two levels down is re-raised at each
   * level, so here it names this stream's tool call and sub-run.
   */
  | {
      type: "error";
      error: AgentError;
      nested?: { toolCallId: string; runId: string; agent: string };
    }
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
