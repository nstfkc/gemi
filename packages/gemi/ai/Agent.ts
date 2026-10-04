import { Log } from "../facades/Log";
import { RequestContext } from "../http/requestContext";
import type { AgentProvider, ProviderToolNamespace, ProviderToolSpec } from "./AgentProvider";
import type { GeneratedImage, GenerateImageParams, ImageInput, ImageModel } from "./ImageModel";
import {
  generateWithin,
  type GenerateParams,
  type GenerateResult,
  type GenerateSuccess,
} from "./generate";
import {
  addUsage,
  appendReasoning,
  appendText,
  bestEffortParse,
  emptyUsage,
  outputFormat,
  parseOutput,
  raceAbort,
  resolveRope,
  RunAborted,
} from "./runtime";
import { supportsStrict } from "./Schema";
import { applyRedaction, rememberUnredacted, ToolError } from "./redact";
import type { ErrorRedactor } from "./redact";
import type { Infer, JSONSchema, Schema } from "./Schema";
import {
  executionReceiptId,
  spendNestedRun,
  spendPendingCall,
  readSignature,
  signNestedRun,
  signPendingCall,
  verifyNestedRun,
  verifyPendingCall,
} from "./signing";
import type {
  Attachment,
  PutAttachmentParams,
  ScopedAttachments,
  ToolAttachmentPut,
  ToolAttachmentRecord,
  ToolAttachments,
} from "./store/Attachments";
import { ATTACHMENT_ID_PREFIX, InvalidAttachmentScopeError } from "./store/Attachments";
import { httpErrorDetail } from "./providers/errors";
import { defaultNonceStore, type NonceStore } from "./store/Nonces";
import type { ReceiptClaim, ReceiptStore } from "./store/Receipts";
import { sseKeepalive } from "./store/sse";
import {
  injectedMessageIds,
  windowMessages,
  type ContextWindowOptions,
} from "./contextWindow";
import type {
  AgentError,
  AgentMessage,
  AgentStreamEvent,
  AgentStreamFrame,
  ClientToolResult,
  ClientTurn,
  FilePart,
  FinishReason,
  NestedRun,
  PendingToolCall,
  ToolCallPart,
  ToolSearchRecord,
  ToolResultPart,
  ToolShapes,
  Usage,
} from "./types";

// --- tools ---------------------------------------------------------------

/**
 * What the app hands a run for its tools to use: who it is for, the ids it is
 * about, and functions the tools call back into — a notifier, a scoped
 * repository, a progress sink.
 *
 * Empty here, and filled in by the app, once, with declaration merging:
 *
 * ```ts
 * declare module "gemi/ai" {
 *   interface AgentContext {
 *     userId: string;
 *     notify?: (message: string) => Promise<void>;
 *   }
 * }
 * ```
 *
 * WHY IT REPLACED `req`. A run used to be handed the HTTP request that started
 * it, and tools read the user off it. That tied every run to a request, and a
 * run started anywhere else — a queued job, a cron, a script — had nothing to
 * pass: `new HttpRequest()` outside a request throws before a model is called.
 * A run needs to know who it is acting for, not how the ask arrived, so the
 * caller now says that directly. `AgentController` builds it from its request
 * in `context()`; a job builds it from its payload.
 *
 * ONE SHAPE FOR THE APP, NOT ONE PER AGENT. Tools are module-scope singletons
 * that any agent may mount, so there is no agent whose type a tool could be
 * checked against. A field only some runs have is optional, and the tool that
 * needs it checks.
 *
 * TRUSTED. Unlike `ctx.body`, nothing here came from the client unless the
 * caller put it there: it is what the server decided the run is for.
 */
// oxlint-disable-next-line no-empty-interface
export interface AgentContext {}

/**
 * Required from a caller when the app's `AgentContext` has a required field,
 * optional when it has none — so an app that never declares one is not made to
 * pass `{}`, and an app that does cannot start a run that forgets it.
 */
type ContextParam = {} extends AgentContext
  ? { context?: AgentContext }
  : { context: AgentContext };

/**
 * Everything a tool needs from the run it is part of.
 *
 * Tools are created once at module scope and shared by every run, so they
 * cannot close over a user or an abort signal — and anything mutable stored on
 * the tool itself would leak across runs. That is why the run's state arrives
 * as an argument instead: the tool stays a singleton and the context is per
 * call.
 */
export interface ToolContext {
  /**
   * What the caller of `Agent.stream` handed the run. See `AgentContext`.
   *
   * The same object for every tool of the run and every sub-run started with
   * `ctx.runAgent` — a sub-agent acts for the same caller, so it is given the
   * same one. `{}` for a run started without one.
   */
  context: AgentContext;
  /**
   * The app's own fields from the turn's request body — what `useChat`'s
   * `body` option sent, minus the keys the turn envelope owns.
   *
   * Carried on the run because `AgentController` has already consumed the
   * body, and a run outlives the request anyway, so by the time a tool
   * executes there is nothing left to read. The values are copied onto the run
   * when it starts.
   *
   * `{}` for a run started with none. Untyped on purpose — a tool is a
   * module-scope singleton that any controller may mount, so there is no one
   * `Body` for it to be. The controller that declares one gets it typed in
   * `instructions()`; a tool validates, the way it would any other input it
   * did not define.
   *
   * CLIENT-CONTROLLED. Same trust as a request body: fine to read, not a
   * finding about who the user is. An id from here says which record the
   * client wants, never that it may have it.
   */
  body: Record<string, unknown>;
  runId: string;
  threadId?: string;
  toolCallId: string;
  /**
   * Aborted when the user calls `stop()`, when the run reaches its
   * `maxRunDurationMs`, and when this call reaches the tool's own `timeoutMs`
   * (with a `TimeoutError` `DOMException` as its `reason`, the same as
   * `AbortSignal.timeout`). Not when the connection drops — a run outlives the
   * request that started it so a refresh can reattach, which means a
   * disconnect is no longer a signal to stop working.
   *
   * Pass it to whatever the tool waits on (`fetch(url, { signal })`). A tool
   * that ignores it does not hold the run open, since the run stops waiting
   * for it either way, but whatever it started keeps running in the
   * background.
   */
  signal: AbortSignal;
  /** Which step of the tool loop this is, starting at 1. */
  step: number;
  /**
   * How deep this tool is inside nested runs: 0 at the top, 1 inside a tool of
   * an agent started by `runAgent`, and so on. Compared against `maxDepth` on
   * `Agent.create` so a cycle — agent A with a tool that runs agent A — fails
   * with a sentence to read instead of exhausting the stack.
   */
  readonly depth: number;
  /**
   * True when this tool is being re-entered after a sub-agent it started asked
   * the user something and the user answered.
   *
   * READ THE `runAgent` NOTE BEFORE USING IT. This is the flag that lets a tool
   * tell a first attempt from a replay, and it exists because there is nothing
   * to tell it otherwise: the tool body ran once already.
   */
  readonly resumed: boolean;
  /**
   * Files, both directions.
   *
   * WHAT THIS FIXES. Before it, files travelled one way: a user's upload became
   * a provider file id the model could look at, and a tool that *produced*
   * something — an edited image, a rendered chart — had a string to return and
   * nowhere to put the bytes. `put(blob)` parks them and answers a record whose
   * `id` is the handle everything else uses; `put(blob, { showModel: true })`
   * also sends them to the provider and puts them in front of the model as an
   * input-role message once this tool call settles, which is what makes
   * generate → look → fix a loop rather than a one-way report.
   *
   * SCOPED, AND THAT IS THE WHOLE SECURITY STORY. The object is built from the
   * `ScopedAttachments` the controller resolved for *this request* (see
   * `AgentController.attachmentScope`), and none of its methods takes a scope,
   * so there is nothing for a tool to pass the model's arguments into. An id
   * that came from another user resolves to `AttachmentNotFoundError`, with the
   * same wording an unknown id gets.
   *
   * PER TOOL CALL, LIKE `runAgent`, AND FOR THE SAME REASON. `put` is memoized
   * by call index within the tool call, so a tool that escalates and is
   * re-entered does not store, upload or inject a second time. Read the note on
   * `ToolAttachments.put` before writing a body whose `put` calls sit in a
   * branch.
   *
   * ALWAYS PRESENT, NEVER NULL. A request with no attachment scope — an
   * unauthenticated, thread-less chat — gets an object whose every method
   * throws with a sentence naming `attachmentScope()`. A nullable `ctx`
   * member would be a guard every tool has to remember and most would not,
   * and the failure of forgetting is a `TypeError` in a tool body rather than
   * an explanation.
   */
  attachments: ToolAttachments;
  /**
   * What the user sent with the turn this tool call answers. See `ToolTurn`.
   */
  readonly turn: ToolTurn;
  /**
   * Runs another agent from inside this tool, wired into the parent run.
   *
   * A tool can already drive a sub-agent by hand — make one, iterate it, yield
   * its events as progress. What this does that hand-rolling cannot is join the
   * two runs: the sub-run inherits `ctx.signal` so the parent's `stop()` reaches
   * it; every sub-run event is re-emitted on the parent stream as
   * `nested-event`, numbered in the parent's `seq`, so `/attach` replay stays
   * correct through the nesting; the sub-run's usage rolls into the parent's;
   * its transcript is recorded on the parent's `ToolCallPart.nested`; and the
   * depth and agent-name chain travel with it, so a cycle fails fast.
   *
   * ESCALATION. If the sub-run ends `awaiting-input` — it has an approval tool,
   * or it asked a question — `onPending: "escalate"` (the default) throws a
   * `PendingEscalation` carrying the inner pending calls, which the parent run
   * collects exactly like pending calls of its own: the parent ends
   * `awaiting-input` with the sub-agent's questions in its list, and the client
   * answers them with the same `approve()` / `answer()` it uses for any other.
   * `onPending: "deny"` refuses them instead and lets the sub-run finish.
   *
   * THE COST, WHICH IS REAL AND WHICH YOU MUST DESIGN AROUND. A JS async
   * generator cannot be suspended across a turn boundary: `awaiting-input` is
   * terminal for the stream, the next turn re-enters the loop at the top and
   * rebuilds its state from the message history, and a paused generator is not
   * in that history and cannot be put there. So an escalating tool is
   * RE-ENTERED FROM THE TOP on the next turn, with `ctx.resumed === true`, and
   * `runAgent` is memoized by call index within the tool call: the Nth
   * `runAgent` of a tool call that already completed on an earlier turn returns
   * its persisted result immediately, calling no provider and running no
   * sub-tool, and only the sub-run that escalated actually continues.
   *
   * The index is the only key there is, so a body whose `runAgent` calls sit in
   * a branch or a loop can produce a different sequence on the replay and make
   * index N mean two different things. That is checked, not trusted: a mismatch
   * fails the tool call with a sentence naming both sub-runs, because pairing a
   * user's answer with a sub-run they never saw would be invisible.
   *
   * Which means: CODE BEFORE AN ESCALATING `runAgent` RUNS AGAIN ON RESUME.
   * Side effects there are repeated. Put your side effects after the
   * `runAgent`, or make them idempotent, or branch on `ctx.resumed`. This is
   * inherent to replay and it is the same bargain the outer tool loop already
   * makes; it is written here in plain words rather than solved with a
   * checkpoint API, because that is a much larger feature than this one.
   */
  runAgent<A extends AnyAgent>(agent: A, params?: RunAgentParams): Promise<NestedRunResult>;

  /**
   * One model call with an output schema, from inside this tool: `generate`,
   * bound to the turn. For a typed answer that needs no tools — where a
   * sub-agent would bring a tool loop nobody wants and stream a transcript to
   * the browser for a value it never renders.
   *
   *     const result = await ctx.generate({ provider, instructions, prompt, output });
   *     if (!result.ok) return { error: result.error.message };
   *
   * WHAT THE BINDING ADDS, and why it is not left to the caller: the call
   * aborts with the turn (`ctx.signal`), and its usage counts toward the turn,
   * the way a nested run's does. Passing the signal by hand is easy to forget
   * and the failure is invisible — a `stop()` that does not stop, and a bill
   * the run under-reports. A `signal` of the tool's own (a timeout) is
   * combined with the turn's, never swapped for it.
   *
   * SERVER ONLY. No frame reaches the client and nothing is written to the
   * transcript; the tool returns whatever it makes of the answer.
   *
   * A BAD ANSWER IS A RESULT, NOT A THROW — `{ ok: false, error, messages,
   * usage }`, so a retry continues `messages` — unless `throwOnError` is set.
   * It is logged unless `logErrors: false`, with the agent, run and tool call
   * it came from. See `generate`. A tool's own `timeoutMs` reaches it through
   * `ctx.signal` and comes back as `code: "timeout"`. The exception is the
   * turn itself being stopped, or reaching its deadline: then this throws, as
   * `runAgent` does, so the body does not carry on with half an answer while
   * the run around it is already closing — its result would be discarded
   * anyway.
   *
   * NOT MEMOIZED. A tool re-entered after an escalation calls the model again,
   * unlike `runAgent` and `generateImage`, which replay from what they recorded
   * on the tool call. This records nothing, by design.
   */
  generate<O extends Schema<any>>(
    params: GenerateParams<O> & { throwOnError: true },
  ): Promise<GenerateSuccess<Infer<O>>>;
  generate<O extends Schema<any>>(params: GenerateParams<O>): Promise<GenerateResult<Infer<O>>>;

  /**
   * Renders an image and parks it, in one step, wired into this tool call.
   *
   * THE SPELLING DIFFERS FROM `ImageModel.generate` ON PURPOSE, and the reason
   * is the same one behind `ctx.runAgent`: an escalating tool is re-entered
   * from the top on the next turn, so a render reached by a bare
   * `model.generate()` inside a tool body is paid for again on every replay —
   * two minutes and an invoice line, for an image whose id the model has
   * already read. This memoizes the render against the tool call, exactly as
   * `ctx.attachments.put` memoizes a store.
   *
   * IT ANSWERS AN `Attachment`, NOT BYTES, and that is forced rather than
   * chosen: the memo lives in the message history, so it cannot hold an image.
   * The bytes are in the app's Storage, which is where a generated image was
   * going anyway; `ctx.attachments.file(id)` hands them back, and copying them
   * under a key of the app's own is what makes the image outlive the run.
   *
   * `showModel: true` puts the result in front of the model as an input-role
   * message once this call settles, so an agent can look at what it made and
   * try again.
   */
  generateImage(model: ImageModel, params: ToolGenerateImageParams): Promise<GeneratedAttachment>;

  /**
   * Edits images and parks the result. Everything above applies.
   *
   * `images` takes attachment ids as well as bytes, and the ids are the point:
   * the image to change is usually the one the model just named ("make that one
   * warmer"), so it arrives with exactly the trust of a request body. Ids are
   * resolved through this call's `ctx.attachments`, which applies #489's scope
   * checks; there is no spelling here that reaches an id outside them.
   */
  editImage(model: ImageModel, params: ToolEditImageParams): Promise<GeneratedAttachment>;
}

/** What an image parked by a tool answers. See `ToolContext.generateImage`. */
export type GeneratedAttachment = {
  attachment: Attachment;
  /** The pixel dimensions the model produced, read off the response. */
  size: string;
  mimeType: string;
  usage: Usage;
};

type ToolImageSettings = Omit<GenerateImageParams, "prompt" | "signal">;

export type ToolGenerateImageParams = ToolImageSettings & {
  prompt: string;
  /** The filename to store it under. Defaults to `<model name>.<extension>`. */
  name?: string;
  /** Also show the model its own output, once this tool call settles. */
  showModel?: boolean;
};

export type ToolEditImageParams = ToolGenerateImageParams & {
  /** Attachment ids, or raw bytes. At least one. */
  images: [ImageInput | string, ...(ImageInput | string)[]];
  mask?: ImageInput | string;
};

/**
 * The files of the turn a tool call belongs to, as data the model cannot write.
 *
 * WHAT THIS FIXES. Every method on `ctx.attachments` takes an id, and before
 * this the only ids a tool could get were the ones the model put in its
 * arguments. So a tool meant to use "the image the user attached" had to trust
 * the model to name it, and a prompt-injected document could name a different
 * upload of the same user's — yesterday's contract instead of today's photo —
 * which the scope check passes, because it is the user's file. Reading the ids
 * from here instead leaves the model nothing to steer.
 *
 * WHICH TURN: THE USER MESSAGE BEFORE THIS CALL, NOT THE LATEST ONE. Found by
 * walking back from the assistant message that made the call, never by taking
 * the last user message in the history when the tool runs, and the difference
 * is re-entry. An escalating tool runs again from the top on a later turn (see
 * `runAgent`), and "latest" is recomputed each time: a turn that answers the
 * sub-agent can carry text or files of its own, and when the re-entered tool
 * asks again, that turn's user message is appended *after* the still-open call
 * — so on the next re-entry "latest" is the answer turn, and a tool that read
 * "the image" would pick a different file, or none, on its second attempt. The
 * replay checks do not reliably catch that: `putMismatch` compares the media
 * type and showModel, never the bytes, and a sub-run seeded with the file as
 * a message part fingerprints as `<file>` whichever file it was. The message
 * that preceded the call is in the history on every attempt and does not
 * move, so every attempt sees the same list.
 *
 * ONE TURN, NOT THE THREAD. The whole thread is what "the image I sent earlier"
 * needs, and it is the wider thing to bind to: a tool that picks "the first
 * image" out of forty turns picks whichever one the history happens to put
 * first, and the user who uploaded a new one sees the old one used. A tool that
 * wants earlier turns can take an id from the model and let the scope check it;
 * one that binds should bind to the turn the user is looking at. A turn with
 * text and no files gives an empty list, which is also the answer to "the user
 * attached nothing this time".
 *
 * NOT THE FILES A TOOL MADE. A file a tool showed with `put(…, { showModel:
 * true })` is injected as a user-role message and carries an `attachmentId`
 * too, and taking it would make it "the user's upload" to the next tool — so
 * the walk steps over every message a tool call's record names as injected,
 * the same test `historyForProvider` uses. A tool that wants what an earlier
 * tool produced has that tool's result to read the id from.
 *
 * IDS ONLY, AND NOT TRUSTED. The name and type beside them on the `FilePart`
 * are what the client said, so they are left off rather than offered as a
 * second, weaker copy of what `ctx.attachments.get(id)` answers from the
 * store. And the ids themselves are only as trustworthy as the history they
 * came from — which, for a stateless client, is whatever it posted. That is
 * fine for the reason everything else about attachments is fine: resolution
 * goes through `ctx.attachments`, whose scope was fixed by the request, so an
 * id from somebody else's upload answers `AttachmentNotFoundError` here
 * exactly as it would from the model's arguments. This list narrows which of
 * the caller's own files a tool reaches for; it grants nothing.
 *
 * Inside a sub-run the turn is the sub-run's own: the message its parent's
 * tool started it with, which has files only if that tool put them there. The
 * parent's upload is not inherited — the tool that called `runAgent` read its
 * own `ctx.turn` and decided what the sub-agent is given.
 */
export interface ToolTurn {
  /**
   * The `attachmentId`s on that user message's file parts, in order, without
   * duplicates, and only ids of gemi's own shape. Frozen, and computed once
   * before the body runs.
   */
  readonly attachments: readonly string[];
}

/** What `ctx.runAgent` is given. `messages` and `prompt` are alternatives. */
export interface RunAgentParams {
  /** Prior turns for the sub-agent. Starts empty when omitted. */
  messages?: AgentMessage[];
  /** Sugar for a single user turn — the common case, and the whole message
   *  list when there is no sub-conversation to continue. */
  prompt?: string;
  /** Appended to the sub-agent's own `instructions`, for this run only. */
  instructions?: string;
  /** Shown on the nested transcript, e.g. "researching pricing". */
  label?: string;
  /**
   * What to do when the sub-run ends `awaiting-input`. `"escalate"` (the
   * default) throws `PendingEscalation` so the question reaches the user;
   * `"deny"` refuses every pending call and lets the sub-run finish, which is
   * what a tool wants when the sub-agent is meant to be autonomous.
   *
   * `"deny"` is refused *in place*, inside the sub-run's own loop, so the
   * sub-agent is told it cannot ask and takes another step rather than ending
   * parked — and it is inherited by everything below, so a grandchild asking to
   * escalate is overruled too. A promise that nothing from this subtree reaches
   * the user is only worth making if the whole subtree keeps it.
   */
  onPending?: "escalate" | "deny";
  /**
   * Override the sub-agent's own ceiling for this run.
   *
   * Not inherited from the parent. A sub-agent is a different job with a
   * different output size — a generator writing a document against a router
   * answering one word — and silently handing down the caller's ceiling would
   * either strangle the one or fail to bound the other.
   */
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * What a completed sub-run gives back.
 *
 * `nested` is the transcript as it is recorded on the parent's tool-call part,
 * so a tool that wants to summarize what its sub-agent did reads the same
 * object the UI renders rather than a second representation of it.
 */
export interface NestedRunResult<O = unknown> {
  runId: string;
  /** The sub-agent's name — carried so a caller that fans out over several
   *  agents can tell the results apart without tracking the order. */
  agent: string;
  messages: AgentMessage[];
  finishReason: FinishReason;
  usage: Usage;
  /** Set when the sub-agent declares an `output` schema and the run finished. */
  output?: O;
  /** Why the sub-run failed: set exactly when `finishReason` is `"error"`. See
   *  `AgentRunResult.error`. */
  error?: AgentRunFailure;
  /** The record written to the parent's `ToolCallPart.nested`. */
  nested: NestedRun;
}

/**
 * Thrown by `ctx.runAgent` when a sub-run ends `awaiting-input`.
 *
 * An exception rather than a return value because it must not be mistaken for
 * an answer: a tool that ignored an `{ escalated: true }` field would return a
 * result to the model as if the sub-agent had finished, and the model would act
 * on an answer nobody gave. `executeTool` lets this one propagate instead of
 * turning it into a `tool_error`, and the step loop collects `pending` exactly
 * like the pending calls it produced itself.
 *
 * `path` is the chain of tool-call ids down to the escalating call; each entry
 * of `pending` already carries its own full path, and this is the prefix they
 * share.
 */
export class PendingEscalation extends Error {
  readonly pending: PendingToolCall[];
  readonly path: string[];
  /** The sub-run that parked, so the parent can record its transcript before
   *  ending the turn — an escalation is a pause, not a lost run. */
  readonly nested: NestedRun;

  constructor(params: { pending: PendingToolCall[]; path: string[]; nested: NestedRun }) {
    super(`A nested agent run is waiting on the user for ${params.pending.length} tool call(s).`);
    this.name = "PendingEscalation";
    this.pending = params.pending;
    this.path = params.path;
    this.nested = params.nested;
  }
}

/**
 * What a per-run `inputSchema` is resolved from: the run's caller and the
 * app's request body, the same `context` and `body` its tools are given.
 */
export interface ToolSchemaContext {
  context: AgentContext;
  /** CLIENT-CONTROLLED, exactly as `ToolContext.body` is. */
  body: Record<string, unknown>;
  runId: string;
  threadId?: string;
  /** Aborted with the run. */
  signal: AbortSignal;
}

/**
 * A tool's input schema: fixed, or resolved once per run.
 *
 * The function form is for a tool whose arguments depend on data — the fields
 * of the collection a page edits, the options a tenant configured. It is
 * called once when a run starts, before the model is shown the tools, and the
 * schema it returns is both what the model sees and what the run validates
 * the tool's arguments against, for every call in that run (a turn that
 * answers a pending call is a new run and resolves it again). Build the
 * schema with `s`, `s.fromJSONSchema` included; it has to be an object at the
 * root, like any tool's.
 *
 * A resolver that throws, or returns a non-object schema, fails the run with
 * `tool_error` before anything is sent to the provider.
 */
export type ToolInputSchema<Input> =
  | Schema<Input>
  | ((ctx: ToolSchemaContext) => Schema<Input> | Promise<Schema<Input>>);

/**
 * A tool either resolves once, or yields progress and then returns.
 *
 * The generator form exists because a tool that takes twenty seconds is the
 * normal case, not the exotic one, and a chat UI that shows nothing for twenty
 * seconds looks broken. Yields become `tool-progress` events; the return value
 * is the result the model sees.
 */
export type ToolExecute<Input, Output, Progress = unknown> = (
  input: Input,
  ctx: ToolContext,
) => Promise<Output> | AsyncGenerator<Progress, Output, void>;

type ToolDefinitionBase<Name extends string, Input, Output> = {
  name: Name;
  /** The model's only description of when to reach for this. */
  description: string;
  /** A schema, or a function resolving one per run. See `ToolInputSchema`. */
  inputSchema: ToolInputSchema<Input>;
  /**
   * Optional for a server tool, required for a client one — there it is what
   * the answer is validated against before the model sees it, and what types
   * the value the browser has to produce.
   */
  outputSchema?: Schema<Output>;
  /**
   * Withholds this tool's parameter schema from the request: the model is shown
   * only the name and description, and pulls the rest in with the provider's
   * `tool_search` when it decides it wants the tool (`defer_loading` on the
   * wire).
   *
   * It says nothing about who runs the tool or when — it is a statement about
   * the prompt, not about execution. What it buys is context: an agent with
   * forty tools spends most of its prompt on schemas for tools it will not
   * call, and deferred ones load at the end of the window, so adding one
   * mid-conversation does not invalidate the cache.
   *
   * Purely an optimization, and gemi treats it as one: a provider that cannot
   * do tool search is sent the schemas inline, and the agent behaves the same.
   * So it is safe to set on a model that does not support it, and worth setting
   * only for tools that are large, numerous, or rarely reached.
   */
  deferred?: boolean;
  /**
   * How long one call of this tool may take, in milliseconds. No limit by
   * default; the run's own `maxRunDurationMs` still bounds it.
   *
   * When it is reached, `ctx.signal` is aborted with a `TimeoutError`, the
   * model gets an `error` result for the call with code `"timeout"`, and the
   * run carries on: the model can retry, try something else, or answer
   * without it. The run stops waiting for the call at that moment, so a tool
   * that ignores `ctx.signal` cannot hold the run open past it, and anything
   * it yields or returns afterwards is dropped.
   *
   * Set it on any tool that waits on something it does not control (a third
   * party API, a `fetch` with no timeout of its own). Not used by client tools,
   * which the server never runs.
   */
  timeoutMs?: number;
};

/**
 * Two ways a tool's result comes to exist, and neither changes the shape of the
 * conversation.
 *
 * `execute` — the server runs it.
 * `answeredBy: "client"` — the browser produces the result: a question for the
 *   user, or something only the page can do. The stream ends `awaiting-input`
 *   and the answer arrives as an ordinary turn.
 *
 * `requiresApproval` applies to the first: the server can run the tool, but
 * asks first. That, too, ends the stream `awaiting-input`, which is the whole
 * reason there is no second endpoint — an approval is a question whose answer
 * happens to be yes or no.
 */
export type ToolDefinition<Name extends string, Input, Output, Progress = never> =
  | (ToolDefinitionBase<Name, Input, Output> & {
      answeredBy?: "server";
      execute: ToolExecute<Input, Output, Progress>;
      requiresApproval?: boolean;
    })
  | (ToolDefinitionBase<Name, Input, Output> & {
      answeredBy: "client";
      outputSchema: Schema<Output>;
      execute?: never;
      /** Meaningless here: the client answering *is* the approval. */
      requiresApproval?: never;
    });

/**
 * `Progress` is inferred, never written down.
 *
 * It comes from the yield type of an `execute` that is an async generator, and
 * from nothing else — a tool that returns a promise gets `never`, which is the
 * honest statement that it cannot yield and is what makes
 * `ToolShapesOf`'s `progress` member safe to emit unconditionally. It is
 * carried as a fourth parameter rather than derived on demand because it has to
 * survive the trip through `ToolNamespace`, `FlattenTools` and `ToolShapesOf`
 * into the browser, and only a type argument does that.
 *
 * Structurally it lives on `execute`, which is optional, and which is also why
 * `AnyAgentTool` must pass `any` here: `Progress` sits covariantly inside
 * `AsyncGenerator<Progress, …>`, so a bound of `never` would make every
 * yielding tool fail the `Extract` in `ToolShapesOf` and silently vanish from
 * the shapes.
 */
export class AgentTool<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  Progress = never,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: ToolInputSchema<Input>;
  readonly outputSchema?: Schema<Output>;
  readonly requiresApproval: boolean;
  readonly deferred: boolean;
  readonly answeredBy: "server" | "client";
  /** See `ToolDefinition.timeoutMs`. `undefined` is no limit of its own. */
  readonly timeoutMs?: number;
  /**
   * There is deliberately no `namespace` here. A tool is a module-scope
   * singleton, so a field naming its group would hold whichever agent
   * constructed its namespace last and report that to every other one — the
   * same global-effect-from-a-local-declaration that `ToolNamespace.deferred`
   * avoids. Where a tool sits is a property of the agent, and it lives on the
   * agent's `ResolvedTool`.
   */
  readonly execute?: ToolExecute<Input, Output, Progress>;

  private constructor(params: ToolDefinition<Name, Input, Output, Progress>) {
    this.name = params.name;
    this.description = params.description;
    this.inputSchema = params.inputSchema;
    this.outputSchema = params.outputSchema;
    this.requiresApproval = params.requiresApproval === true;
    this.deferred = params.deferred === true;
    this.answeredBy = params.answeredBy === "client" ? "client" : "server";
    this.execute = params.execute ?? undefined;
    this.timeoutMs = params.timeoutMs;
  }

  /**
   * `const` on the params is what preserves `name` as a literal, which is what
   * lets the browser discriminate a tool part by name.
   */
  static create<const Name extends string, Input, Output, Progress = never>(
    params: ToolDefinition<Name, Input, Output, Progress>,
  ): AgentTool<Name, Input, Output, Progress> {
    // Only the input: it is the one schema the provider is shown. The
    // `outputSchema` validates what `execute` or the browser hands back and is
    // never sent, so any shape is fine there.
    // A per-run schema is checked when a run resolves it.
    if (typeof params.inputSchema !== "function") {
      assertObjectRoot(params.inputSchema, `The tool "${params.name}"`, "inputSchema");
    }
    if (params.timeoutMs !== undefined) {
      assertDuration(params.timeoutMs, `The tool "${params.name}"`, "timeoutMs");
    }
    return new AgentTool(params);
  }

  /**
   * Sugar for the common client tool: the agent asks the user something and
   * waits. Equivalent to `answeredBy: "client"` with an input schema of one
   * prompt field.
   */
  static ask<const Name extends string, Output>(params: {
    name: Name;
    description: string;
    outputSchema: Schema<Output>;
  }): AgentTool<Name, { question: string }, Output> {
    return AgentTool.create({
      name: params.name,
      description: params.description,
      inputSchema: questionSchema,
      outputSchema: params.outputSchema,
      answeredBy: "client",
    });
  }
}

/**
 * The one schema this module owns, rather than one built with `s`.
 *
 * `Schema<T>` carries a phantom property keyed by a symbol `Schema.ts` does not
 * export, so nothing outside that file can produce one without a cast — and
 * reaching for `s` here would make the agent runtime depend on the schema
 * builder for a single hard-coded object. One field, no `describe`, no
 * optionality: the cast is cheaper than the coupling.
 */
const questionSchema = {
  toJSONSchema: () => ({
    type: "object",
    properties: { question: { type: "string", description: "What to ask the user" } },
    required: ["question"],
    additionalProperties: false as const,
  }),
  parse(value: unknown) {
    const result = questionSchema.safeParse(value);
    if (result.ok === false) throw new Error(result.errors.join(", "));
    return result.value;
  },
  safeParse(value: unknown) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as any).question !== "string"
    ) {
      return { ok: false as const, errors: ["question: expected a string"] };
    }
    return { ok: true as const, value: { question: (value as any).question } };
  },
} as unknown as Schema<{ question: string }>;

export type AnyAgentTool = AgentTool<string, any, any, any>;

/**
 * A group of tools the model can search as a unit.
 *
 * The provider's tool search works over namespaces, and the guidance is fewer
 * than ten functions in each — the model looks at a namespace's description to
 * decide whether anything inside is worth loading, so the grouping is part of
 * the prompt, not bookkeeping. A namespace is also the only place a
 * *collection* of tools can be described; on a flat list that sentence has
 * nowhere to go.
 *
 * Tool names stay globally unique within an agent, so the browser still
 * discriminates on `name` alone and the namespace never leaks into the client's
 * types.
 */
export class ToolNamespace<
  Name extends string = string,
  T extends readonly AnyAgentTool[] = readonly AnyAgentTool[],
> {
  readonly name: Name;
  readonly description: string;
  readonly tools: T;
  /**
   * Kept here rather than pushed onto each tool. A tool is a module-scope
   * singleton and may be listed bare as well as inside a group; writing the
   * group's `deferred` onto it would defer it everywhere, which is a global
   * effect from a local declaration.
   */
  readonly deferred: boolean;

  private constructor(params: { name: Name; description: string; tools: T; deferred?: boolean }) {
    this.name = params.name;
    this.description = params.description;
    this.tools = params.tools;
    this.deferred = params.deferred === true;
  }

  static create<const Name extends string, const T extends readonly AnyAgentTool[]>(params: {
    name: Name;
    /** What the model reads when deciding whether to search inside. */
    description: string;
    tools: T;
    /** Defers every tool in the group, so the whole namespace costs its own
     *  description plus one line per tool until something is loaded. */
    deferred?: boolean;
  }): ToolNamespace<Name, T> {
    return new ToolNamespace(params);
  }
}

/** What an agent's `tools` may hold: tools, or namespaces of them. */
export type ToolEntry = AnyAgentTool | ToolNamespace<string, readonly AnyAgentTool[]>;

type FlattenTools<T extends readonly ToolEntry[]> = T[number] extends infer E
  ? E extends ToolNamespace<any, infer NT>
    ? NT[number]
    : E
  : never;

/**
 * The tool tuple, erased to the payload types the client is allowed to see.
 *
 * `progress` is emitted for every tool, `never` included, rather than only for
 * the ones that can yield. A conditional that dropped the member would make
 * `T[K]["progress"]` in `types.ts` resolve differently per tool, and this
 * package compiles with `strict: false` — where `undefined extends T` is true
 * of everything and an optional member is indistinguishable from a required
 * one. Two inference bugs in this module already came from testing a shape
 * under those options and believing the answer (see `OptionalSchema` in
 * `Schema.ts`); an unconditional member has nothing to get wrong.
 */
export type ToolShapesOf<T extends readonly ToolEntry[]> =
  ShapesOf<NamedTools<Extract<FlattenTools<T>, AnyAgentTool>>> extends infer Named
    ? [keyof Named] extends [never]
      ? ShapesOf<Extract<FlattenTools<T>, AnyAgentTool>>
      : Named
    : never;

/**
 * The tools whose name is a literal (#771). A tool named only `string` — an
 * untyped `toAgentTools`, or one built from a name read at runtime — would
 * give the shapes a string index signature, and `ToolCallPart`, which indexes
 * the shapes by `keyof`, would then answer the index's untyped member for
 * every tool, the literal ones included. So it is left out, and degrades only
 * itself: its parts are not in the client's union. An agent with no literal
 * name at all keeps the index, as before.
 */
type NamedTools<K> = K extends AnyAgentTool ? (string extends K["name"] ? never : K) : never;

type ShapesOf<U extends AnyAgentTool> = {
  [K in U as K["name"]]: K extends AgentTool<any, infer I, infer O, infer P>
    ? { input: I; output: O; progress: P }
    : never;
};

// --- skills --------------------------------------------------------------

/**
 * A skill is instructions the model can go and fetch.
 *
 * Inlining every skill into the system prompt costs its tokens on every request
 * and gets worse with each skill added. So a skill is lowered to a tool: one
 * zero-parameter function per skill, in a reserved `skills` namespace, whose
 * description is the skill's and whose result is `instructions` plus any
 * `files`. Only those descriptions are prompted, and a skill the model never
 * reaches for costs a line of text.
 *
 * Lowering to a tool rather than to a synthetic `load_skill(name)` dispatcher
 * is the whole trick: discovery is then the same mechanism as everything else
 * the model chooses between, which means it runs on the provider's own
 * tool-selection machinery instead of on a string argument gemi would have to
 * validate, and a skill that is never loaded is a namespace entry rather than a
 * branch in our code. It is also why `deferred` applies here unchanged — with
 * tool search the namespace is searched, and without it the same tools are
 * listed inline, which for zero-parameter functions costs almost nothing.
 */
export interface SkillDefinition<Name extends string = string> {
  name: Name;
  /** Read on every request — this is what the model decides to load from. */
  description: string;
  /** A thunk so a large body stays off the startup path and out of memory. */
  instructions: string | (() => string | Promise<string>);
  /** Paths resolved relative to the app root, appended after `instructions`. */
  files?: string[];
}

export class Skill<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly instructions: string | (() => string | Promise<string>);
  readonly files?: string[];

  private constructor(params: SkillDefinition<Name>) {
    this.name = params.name;
    this.description = params.description;
    this.instructions = params.instructions;
    this.files = params.files;
  }

  static create<const Name extends string>(params: SkillDefinition<Name>): Skill<Name> {
    return new Skill(params);
  }
}

/** Reserved: a skill is lowered into a namespace of exactly this name. */
export const SKILLS_NAMESPACE = "skills";

const SKILLS_NAMESPACE_DESCRIPTION =
  "Instructions this agent can load on demand. Load the relevant one before acting in the area it covers.";

/**
 * Throws unless `schema` emits an object at its root.
 *
 * Both places a schema reaches the provider — a tool's parameters and an
 * agent's structured `output` — require one there: OpenAI's strict function
 * parameters and strict `json_schema` reject `anyOf` at the root (it is legal
 * only under a property), and a primitive or array root is not a parameter
 * list at all. Left to the provider, that is a 400 on the first request that
 * carries the schema, which an app then has to decode; checked here, it is an
 * error at startup naming the tool or agent that declared it.
 *
 * Read off the emitted JSON Schema rather than the builder's tree, so that a
 * hand-built schema (`questionSchema`, the skills' empty one, MCP's merged
 * input) is held to the same rule as one built with `s`.
 */
function assertObjectRoot(schema: Schema<any>, owner: string, field: string): void {
  const json: JSONSchema | undefined = schema?.toJSONSchema?.();
  if (json?.type === "object") return;
  const found = !json
    ? "no JSON Schema"
    : json.anyOf
      ? "a union (`anyOf`) — `s.union(...)`"
      : json.type !== undefined
        ? `a schema of type ${JSON.stringify(json.type)}`
        : "an unconstrained schema (`s.json()`)";
  throw new Error(
    `${owner} declares an \`${field}\` whose root is ${found}, but the provider only accepts an object there (OpenAI rejects \`anyOf\` or a non-object at the root of tool parameters and structured output). Wrap it in an object, e.g. \`s.object({ value: s.union([...]) })\`, and read \`.value\` off the result.`,
  );
}

/**
 * A time limit has to be a positive number of milliseconds. `0` and a negative
 * number are refused rather than read as "no limit" or "already expired": both
 * readings are plausible, and a run that times out on its first tick, or a
 * limit that silently does nothing, is the kind of surprise worth an error at
 * startup instead.
 */
function assertDuration(value: unknown, owner: string, field: string): void {
  if (typeof value === "number" && value > 0) return;
  throw new Error(
    `${owner} sets \`${field}\` to ${String(value)}, but it has to be a positive number of milliseconds. Use \`null\` for no limit.`,
  );
}

/** `Infinity` and `null` both mean "no limit"; `undefined` means "not said". */
function normalizeDuration(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || !Number.isFinite(value)) return null;
  return value;
}

/**
 * The longest delay `setTimeout` keeps: past it the runtime fires in about a
 * millisecond, which for a deadline would mean "expire now". A limit longer
 * than this (about 24.8 days) is no limit in practice and is treated as one.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Calls `onExpire` after `ms`, unless `ms` is no limit. Returns the cancel.
 */
function startTimer(ms: number | null, onExpire: () => void): () => void {
  if (ms === null || ms > MAX_TIMER_MS) return () => {};
  const timer = setTimeout(onExpire, ms);
  return () => clearTimeout(timer);
}

/** `1500` as "1.5s", `600000` as "10m": for messages a model and a log read. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(1)}s`;
  return `${+(ms / 60_000).toFixed(1)}m`;
}

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  required: [] as string[],
  additionalProperties: false as const,
};

// --- agent ---------------------------------------------------------------

/**
 * How hard the model should think before it answers, sent as the provider's own
 * effort setting (`reasoning.effort` on the Responses API).
 *
 * WHICH VALUES A MODEL TAKES IS THE MODEL'S BUSINESS, not gemi's. gpt-5 takes
 * `"minimal"` and not `"none"`; gpt-5.1 and later take `"none"`; Azure's
 * gpt-6-sol answers 400 to `"minimal"` and lists `none | low | medium | high |
 * xhigh | max` (#658). A closed union meant an app could not say the one value
 * its model wanted, and every new value waited on a gemi release. So the known
 * values are listed for autocomplete and any other string is passed through
 * unchanged — the same bet `capabilitiesForModel` makes on unknown model ids: a
 * value the model rejects fails loudly, once, with the API naming the values it
 * does accept (on `result().error`), and the fix is one line.
 *
 * `"none"` turns reasoning off on models that support it, which is what a short,
 * latency-bound call wants: with any effort at all, `maxOutputTokens` caps the
 * reasoning tokens too, and a small cap can be spent entirely on thinking. It is
 * not the same as leaving `reasoning` unset, which gets the model's default
 * (usually `"medium"`). On a model with no reasoning parameter at all
 * (`capabilities.reasoning` is false) every value, `"none"` included, is
 * dropped, since there is nothing to turn off.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  // `string & {}` keeps the literals above in autocomplete; a bare `string`
  // would swallow them.
  | (string & {});

export interface CreateAgentParams<
  T extends readonly ToolEntry[],
  S extends readonly Skill[],
  O extends Schema<any> | undefined,
> {
  name: string;
  /** The system prompt. Per-request additions belong on the controller, which
   *  has the request; this is the part that is the same for everyone. */
  instructions?: string;
  provider: AgentProvider;
  tools?: T;
  /** Lowered into the reserved `skills` namespace — see `Skill`. The name is
   *  reserved, so a namespace of your own cannot be called `skills`. */
  skills?: S;
  /**
   * Makes the final assistant turn strict JSON instead of prose. Tool turns are
   * unaffected — only the answer is constrained, which is the only place a
   * schema can apply once there is a tool loop.
   */
  output?: O;
  /** Ends the run with `finishReason: "max-steps"` rather than throwing: an
   *  agent that loops is a bug to show, not an exception to swallow. */
  maxSteps?: number;
  /**
   * How far `ctx.runAgent` may nest below this agent. Default 3.
   *
   * It is a limit on the *tree*, taken from the run at the root, so raising it
   * on a sub-agent cannot deepen a run it did not start. A cycle is caught by
   * the agent-name chain before this is reached — this is for the mutually
   * recursive shape a name check cannot see, and for the merely runaway one.
   */
  maxDepth?: number;
  /** The model's reasoning effort, e.g. `"none"` for a quick one-liner or
   *  `"high"` for a hard problem. Unset gets the model's default. Any string
   *  the model accepts works — see `ReasoningEffort`. */
  reasoning?: ReasoningEffort;
  /**
   * A ceiling on the tokens one model call may produce, passed to the provider
   * as its own `max_output_tokens`.
   *
   * It bounds a degenerate generation. A model asked for non-strict JSON can
   * fall into emitting the same character until something stops it, and with
   * no cap the only thing that does is the client giving up — a turn that
   * never ends rather than one that fails. The cap turns that into a run
   * ending with `finishReason: "length"`, which an app can retry.
   *
   * Per model call, not per run: a run of four steps may produce four times
   * this. `maxSteps` is the bound on the run.
   */
  maxOutputTokens?: number;
  /**
   * Passed to the provider unchanged. Lower is steadier, which is worth having
   * for a generation whose shape matters more than its phrasing.
   *
   * SENT WHENEVER SET, and not capability-gated the way `reasoning` is.
   * `ProviderCapabilities` carries no flag for it, so `buildResponsesRequest`
   * writes it whenever it is a number and never drops it. That matters because
   * the newer reasoning models reject the parameter outright: setting this for
   * one is a 400 rather than a quietly degraded request. It is the same bargain
   * `output` takes in `request.ts` — an explicit choice is sent and the API gets
   * to say no, because silently dropping one leaves an app believing something
   * about its request that is not true.
   */
  temperature?: number;
  /**
   * Whether a run of this agent that ends with `finishReason: "error"` is
   * written to the app's log (`Log.error`, so `storage/logs` and the log
   * config's `onLogCreated`). Default `true`.
   *
   * On by default because the failure otherwise exists only as an `error` frame
   * on a stream a server-side caller may never read, and `result()` resolves
   * rather than rejects. A provider that cannot be reached, or a 400 for a
   * parameter the model refuses, then looks like an agent that said nothing.
   * Turn it off when the app already reports `result().error` (or the
   * controller's `onError`) itself and a second line would be noise.
   *
   * Also covers a tool that throws anything but a `ToolError`: the model and
   * the client only read that it failed (see `redactError`), so the log is
   * where its message and stack are.
   */
  logErrors?: boolean;
  /**
   * The longest one run of this agent may take, in milliseconds. Default
   * `DEFAULT_MAX_RUN_DURATION_MS`, ten minutes. `null` (or `Infinity`) turns
   * the limit off.
   *
   * When it is reached the run is stopped the way `stop()` stops it (every
   * tool call still in flight gets a `denied` result, `ctx.signal` aborts, the
   * provider request is cancelled) and it ends with `finishReason: "error"`
   * and `result().error.code` `"timeout"`, so it is logged and
   * `result({ throwOnError: true })` rejects. The transcript is finalized and
   * stored like any other.
   *
   * ON BY DEFAULT because the failure it bounds is silent and permanent. A tool
   * that never settles (a `fetch` with no timeout) used to keep its run open
   * for the life of the process, and the live-run registry with it: nobody is
   * watching, nobody calls `/stop`, and nothing expires. Ten minutes is far
   * past any interactive turn (a turn is `maxSteps` model calls plus their
   * tools), and it is per run, not per thread. Time spent waiting for the user
   * does not count, since a run waiting for input has already ended
   * (`awaiting-input`). Raise it for an agent whose runs are legitimately
   * long, such as a batch job or a long research loop.
   *
   * A sub-run started with `ctx.runAgent` is bounded by its parent's limit,
   * since it shares the parent's signal, and has none of its own unless its
   * agent sets one explicitly.
   */
  maxRunDurationMs?: number | null;
  /**
   * Bounds what each model call of this agent is sent: the latest turns of the
   * history that fit, cut at a turn start, with the cut moving in steps so the
   * provider's prompt cache keeps hitting. See `ContextWindowOptions` and
   * `windowMessages`. Unset (the default) sends the whole history, as before.
   *
   * Only the request changes. The run's history, `onMessage`, the store and
   * `result().messages` hold every message, so a thread stays whole and a
   * later turn can be sent a different window.
   */
  contextWindow?: ContextWindowOptions;
  /**
   * Called before every model call of a run of this agent, with the messages
   * about to be sent (after `contextWindow`), and may answer other ones, or
   * other instructions, for that call alone. See `PrepareStep`.
   */
  prepareStep?: PrepareStep;
}

/**
 * What `prepareStep` is told before a model call.
 */
export type PrepareStepContext = {
  /** 1 for the run's first model call, 2 for the one after its tools ran, … */
  step: number;
  /**
   * What this call would send: the run's history (stored and new), with older
   * tool-produced files already swapped for a line of text, and cut to
   * `contextWindow` when one is set. Copies where anything was changed; never
   * mutate a message in it, since the others are the run's own.
   */
  messages: AgentMessage[];
  /** The same history before `contextWindow` cut it. */
  history: readonly AgentMessage[];
  /** The system prompt this call would send. */
  instructions: string | undefined;
  /** What the run has spent so far, tools' sub-runs included. */
  usage: Usage;
  /** The previous model call's own usage, when it reported one. Its
   *  `inputTokens` is how big the last request actually was. */
  lastStepUsage?: Usage;
  /** How the previous model call of this run ended. Absent on step 1. */
  lastFinishReason?: FinishReason;
  runId: string;
  threadId?: string;
  /** The agent's name. */
  agent: string;
  /** 0 for a run started at the top, 1 for a sub-run of one of its tools, … */
  depth: number;
  context: AgentContext;
  signal: AbortSignal;
};

/**
 * What `prepareStep` may change for one model call. Anything left out is sent
 * as it would have been.
 */
export type PrepareStepResult = {
  /**
   * The messages to send instead. Never stored, and the next step starts from
   * the run's history again rather than from these. A tool call left without
   * its result (or a result without its call) is repaired by the provider's
   * request builder, but cutting at `turnStarts` avoids it altogether.
   */
  messages?: AgentMessage[];
  /** The system prompt to send instead. */
  instructions?: string;
};

/**
 * A hook before every model call: see `CreateAgentParams.prepareStep`. It may
 * be async, and anything it throws fails the run (`finishReason: "error"`).
 *
 * The usual job is the context window: `windowMessages` with options decided
 * per call, a summary in place of older turns, a note. Keep it deterministic
 * for the same history and the provider's prompt cache keeps working.
 */
export type PrepareStep = (
  ctx: PrepareStepContext,
) => PrepareStepResult | void | Promise<PrepareStepResult | void>;

/**
 * How long a run may take when its agent does not say. See
 * `CreateAgentParams.maxRunDurationMs`.
 */
export const DEFAULT_MAX_RUN_DURATION_MS = 10 * 60 * 1000;

/**
 * One call per client turn — a first message and an answer to a pending
 * approval take the same path, because they are the same thing: the next turn
 * of a conversation.
 */
export type AgentStreamParams = AgentStreamParamsBase & ContextParam;

interface AgentStreamParamsBase {
  /** Prior turns. The controller loads these from its store, or takes what the
   *  client sent when running stateless. */
  messages: AgentMessage[];
  /** The client's turn: text, answers to pending calls, or both. */
  turn?: ClientTurn;
  /** Aborted by an explicit `stop`, not by a disconnect. */
  signal?: AbortSignal;
  runId?: string;
  threadId?: string;
  /** Appended to the agent's own `instructions` for this request only. */
  instructions?: string;
  /**
   * The app's own fields from the turn's request body, handed to every tool of
   * this run as `ctx.body`.
   *
   * Carried on the run because a run outlives the request that started it, so
   * that a refresh can reattach, and by the time a tool executes there is no
   * body left to read. See `AgentController`'s `Body`.
   */
  body?: Record<string, unknown>;
  /** Per-request model choice, e.g. letting a user pick. */
  provider?: AgentProvider;
  maxSteps?: number;
  reasoning?: ReasoningEffort;
  /** Overrides the agent's own for this run. A generation whose size varies by
   *  request — a page with ten components against one with two — is the case
   *  a fixed ceiling on the agent cannot serve. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Overrides the agent's `maxRunDurationMs` for this run. `null` turns the
   *  limit off. */
  maxRunDurationMs?: number | null;
  /**
   * Overrides the agent's `contextWindow` for this run. `false` sends the whole
   * history even when the agent sets one. Not handed down to a sub-run, which
   * uses its own agent's.
   */
  contextWindow?: ContextWindowOptions | false;
  /**
   * Runs after the agent's own `prepareStep`, on what that answered. Not
   * handed down to a sub-run. `AgentController` sets this from its
   * `prepareStep` method.
   */
  prepareStep?: PrepareStep;
  /**
   * Fires once for every message this run completes — the user's turn, each
   * assistant turn, and any earlier message this turn amended by resolving a
   * pending call. It is the controller's persistence point, and it fires
   * whether or not anyone is still reading the stream, which is what makes a
   * run that outlives its request useful.
   *
   * A message may be reported twice across runs under the same id when a
   * pending call is resolved later; a store keyed by id should upsert.
   */
  onMessage?: (message: AgentMessage) => void | Promise<void>;
  /**
   * What a client is told about a failure: the run's `error` frame, and the
   * result of a tool that threw (which the model reads too). Default
   * `redactError`, which keeps the code and replaces any message gemi did not
   * write (a provider's error body, an exception's text) with a fixed
   * sentence, since those carry hostnames, resource names, request ids and
   * connection strings. A tool that throws a `ToolError` keeps its message.
   *
   * Full detail stays server-side: on `result().error`, in the log, and in
   * the controller's `onError`. `AgentController` sets this from its
   * `redactError` method. Handed down unchanged to a sub-run.
   */
  redactError?: ErrorRedactor;
  /**
   * Where the nonces of answered pending calls and re-entered sub-run records
   * are spent, which is what makes a signed answer single-use (#445). Default
   * the process-wide `MemoryNonceStore`: exact for one instance, but with
   * several each would accept a replayed answer once. Give a shared store
   * (`RedisNonceStore`, or your own `NonceStore`) when running more than one.
   * `AgentController` sets this from its `nonces`. Handed down unchanged to a
   * sub-run.
   */
  nonces?: NonceStore;
  /**
   * Where an approved tool's execution is claimed and its result recorded,
   * which is what makes an approval run its tool at most once (#458). Before
   * an approved tool runs, the run claims an id derived from the call the
   * approval covers: a presentation of an approval that already ran gets the
   * recorded result back instead of running the tool again, and one presented
   * while another instance is still running it gets a `tool_error` result.
   * Without a store an approved tool runs as before, guarded by the nonce
   * alone. `AgentController` sets this from its `receipts`. Handed down
   * unchanged to a sub-run.
   */
  receipts?: ReceiptStore;
  /**
   * Who this run is answering: the principal every pending call and parked
   * sub-run record it mints is bound to (#447). An answer, or a record, only
   * verifies on a later run with the same `subject`, so a token lifted from
   * one user's history cannot be spent in another user's turn. `null`, or
   * omitted, is an anonymous run, and only verifies on another anonymous one.
   *
   * `AgentController` sets this from `runOwner` (`user:<id>` by default), so it
   * must answer the same on the turn that asks and the turn that answers.
   * Handed down unchanged to a sub-run.
   */
  subject?: string | null;
  /**
   * The attachment handle every tool of this run is given as `ctx.attachments`.
   *
   * Resolved by the controller from the request — `attachmentsFor(req,
   * threadId)` — and passed in rather than reached for, because the scope is a
   * fact about the caller and the run has no way to derive one. `null`, or
   * omitted, is a request with no subject: the object tools get still exists
   * and every method on it throws a sentence naming `attachmentScope()`.
   *
   * Handed down unchanged to a sub-run started by `ctx.runAgent`. A sub-agent
   * is running on behalf of the same caller — that is the only reason it is
   * allowed to run at all — so it reads and writes the same scope, and a tool
   * three levels down can be given an id its parent parked. Widening it here
   * would be the confused-deputy hole in reverse.
   */
  attachments?: ScopedAttachments | null;
  /**
   * Set by `ctx.runAgent` and by nothing else.
   *
   * It rides on the public params rather than on a back door because
   * `Agent.stream` is the only way to start a run and a sub-run is a run —
   * giving nesting its own construction path would mean two places where a run
   * is set up, and the second one would drift. Omitted, a run is a root: depth
   * 0, no path, signatures over its own id.
   */
  nesting?: NestedContext;
}

/**
 * Where a run sits inside a tree of runs. Carried down by `ctx.runAgent`.
 *
 * `signingRunId` and `signingPath` are the reason this is threaded rather than
 * recomputed: a pending call a sub-agent raises is answered by the *client*,
 * which only ever sees the root run, so the token has to be minted under the
 * root's id and the sub-run's path from the start. Re-signing the token at each
 * level on the way up would work too, and would throw away every signature but
 * the outermost one — this way the run that asks the question is also the run
 * that can check the answer, which is where the tool, its schema and its `kind`
 * all already are.
 */
export type NestedContext = {
  /** 0 at the root; `ctx.depth` inside a tool of this run. */
  depth: number;
  /** The `maxDepth` of the run at the root of the tree. */
  maxDepth: number;
  /** Agent names from the root down to and including this one, so a cycle can
   *  be reported as the chain that caused it. */
  chain: string[];
  /** The root run's id: what a pending call raised here is signed under. */
  signingRunId: string;
  /** Tool-call ids from the root down to the call that started this run. */
  signingPath: string[];
  /**
   * Inherited, and once it is `"deny"` it stays `"deny"` all the way down. A
   * caller that asked for an autonomous sub-agent must not have a question
   * surface from three levels below it, and the only way to promise that is to
   * make the whole subtree refuse rather than to check at the top.
   */
  onPending: "escalate" | "deny";
};

/**
 * Why a run ended with `finishReason: "error"`, as the server sees it.
 *
 * The same `code`, `message` and `retryable` as the `error` frame the run put
 * on its stream, plus what only the server should have: the HTTP `status` and
 * the provider's `requestId` when the failure was a response from the
 * provider. Neither is ever written to a frame. A frame is built from this
 * through one method (`redact`), which copies the `AgentError` fields by name,
 * so a field added here stays server-side unless someone puts it there on
 * purpose, and redacts the message (#446, see `redactError`).
 *
 * `message` is the provider's own sentence ("Unsupported parameter:
 * 'temperature' ..."), which is what a log needs and why this is kept off the
 * wire in any form richer than the frame already is.
 */
export type AgentRunFailure = AgentError & {
  /** The provider's HTTP status, when the failure was a non-2xx response. */
  status?: number;
  /** The provider's request id (`x-request-id`), when it sent one. */
  requestId?: string;
};

export type AgentRunResult<T extends ToolShapes, O> = {
  runId: string;
  /** Everything produced this run — the controller persists these. */
  messages: AgentMessage<T, O>[];
  finishReason: FinishReason;
  usage: Usage;
  /** Set when the agent declares an `output` schema and the run finished. */
  output?: O;
  /**
   * Why the run failed. Set exactly when `finishReason` is `"error"`, and
   * absent otherwise — an aborted run, `max-steps` and `length` are outcomes,
   * not failures, and carry no error.
   *
   * Before this field a server-side caller that awaited `result()` saw only
   * `finishReason: "error"` and no output: the cause was an `error` event on a
   * stream it never read. Pass `result({ throwOnError: true })` to have the run
   * reject with an `AgentRunError` instead.
   */
  error?: AgentRunFailure;
};

export type AgentResultOptions = {
  /**
   * Reject with an `AgentRunError` when the run ends with
   * `finishReason: "error"`, instead of resolving with `result.error` set.
   * Every other finish reason resolves as usual. Default `false`.
   */
  throwOnError?: boolean;
};

/**
 * What `result({ throwOnError: true })` rejects with.
 *
 * It carries the whole `result` as well as the error's fields, because a run
 * that failed on step three still produced steps one and two — their messages
 * and their usage are billed and may need persisting — and a rejection that
 * dropped them would make `throwOnError` the lossy way to call `result()`.
 */
export class AgentRunError extends Error {
  readonly code: AgentRunFailure["code"];
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly toolCallId?: string;
  readonly runId: string;
  readonly result: AgentRunResult<ToolShapes, unknown>;

  constructor(result: AgentRunResult<ToolShapes, unknown> & { error: AgentRunFailure }) {
    super(result.error.message);
    this.name = "AgentRunError";
    this.code = result.error.code;
    this.retryable = result.error.retryable;
    this.status = result.error.status;
    this.requestId = result.error.requestId;
    this.toolCallId = result.error.toolCallId;
    this.runId = result.runId;
    this.result = result;
  }
}

/**
 * A run is an async iterable of events, and the SSE encoding is a method on it
 * rather than a separate helper — so the same object serves a controller
 * returning a `Response` and a server-side caller that just wants to await the
 * result.
 *
 * A run keeps going when its request ends. That is what makes reattaching after
 * a refresh possible, and it is why `stop()` is an explicit call rather than the
 * client closing a socket.
 */
export interface AgentRun<T extends ToolShapes = ToolShapes, O = unknown> extends AsyncIterable<
  AgentStreamEvent<T, O>
> {
  readonly runId: string;
  /** Numbered events, replayable from a cursor. `toResponse` is this, encoded. */
  frames(from?: number): AsyncIterable<AgentStreamFrame<T, O>>;
  toResponse(params?: { from?: number }): Response;
  /**
   * Settles when the run is over. Resolves for every finish reason, `"error"`
   * included, with the cause on `result.error`; pass `{ throwOnError: true }`
   * to reject with an `AgentRunError` for that one instead.
   */
  result(options?: AgentResultOptions): Promise<AgentRunResult<T, O>>;
  /**
   * Cancels the run and closes the conversation behind it: every tool call
   * still in flight gets a `denied` result with `cause: "stopped"`, the
   * assistant message is finalized with `finishReason: "aborted"`, and both go
   * through `onMessage` like any other message.
   *
   * That last part is the point. A cancel that merely stops emitting leaves a
   * history the provider will reject on the next turn, so the run's last act is
   * to make the transcript valid — which is also what lets the user carry on
   * talking instead of starting over.
   */
  stop(params?: { reason?: string }): void;
}

/**
 * A tool plus where it sits in the prompt. Fixed for the life of the agent,
 * except `inputSchema`, which a run fills in for a tool whose schema is
 * resolved per run (`ToolInputSchema`).
 */
type ResolvedTool = {
  tool: AnyAgentTool;
  namespace?: string;
  deferred: boolean;
  /** `undefined` until the run resolves a per-run schema. */
  inputSchema?: Schema<any>;
};

/** What a run needs from its agent, resolved once at `Agent.create`. */
type RunConfig = {
  name: string;
  instructions?: string;
  provider: AgentProvider;
  registry: Map<string, ResolvedTool>;
  providerTools: (ProviderToolSpec | ProviderToolNamespace)[];
  output?: Schema<any>;
  maxSteps: number;
  maxDepth: number;
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  temperature?: number;
  logErrors: boolean;
  /**
   * As the agent or the stream params gave it, with `Infinity` already folded
   * into `null`. `undefined` is "not said", which a root run reads as
   * `DEFAULT_MAX_RUN_DURATION_MS` and a sub-run as no limit of its own.
   */
  maxRunDurationMs: number | null | undefined;
  contextWindow?: ContextWindowOptions;
  /** The agent's hook, then the stream's, in that order. */
  prepareStep: PrepareStep[];
};

const DEFAULT_MAX_STEPS = 8;
/** Three is enough for "agent, sub-agent, specialist" and small enough that a
 *  runaway tree is a readable error rather than a stack trace. */
const DEFAULT_MAX_DEPTH = 3;

export class Agent<
  T extends readonly ToolEntry[] = readonly ToolEntry[],
  S extends readonly Skill[] = readonly Skill[],
  O extends Schema<any> | undefined = undefined,
> {
  readonly name: string;
  readonly tools: T;
  readonly skills: S;
  readonly provider: AgentProvider;
  readonly output: O;
  readonly instructions?: string;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly reasoning?: ReasoningEffort;
  /**
   * The time limit a run of this agent gets when it is started at the top (a
   * sub-run is bounded by its parent): `DEFAULT_MAX_RUN_DURATION_MS` unless
   * `Agent.create` said otherwise, and `null` for no limit.
   */
  readonly maxRunDurationMs: number | null;

  private readonly config: RunConfig;

  private constructor(params: CreateAgentParams<T, S, O>) {
    this.name = params.name;
    this.instructions = params.instructions;
    this.provider = params.provider;
    this.tools = (params.tools ?? ([] as unknown as T)) as T;
    this.skills = (params.skills ?? ([] as unknown as S)) as S;
    this.output = params.output as O;
    this.maxSteps = params.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxDepth = params.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.reasoning = params.reasoning;
    const limit = normalizeDuration(params.maxRunDurationMs);
    this.maxRunDurationMs = limit === undefined ? DEFAULT_MAX_RUN_DURATION_MS : limit;

    const { registry, providerTools } = lowerTools(this.tools, this.skills);
    this.config = {
      name: this.name,
      instructions: this.instructions,
      provider: this.provider,
      registry,
      providerTools,
      output: params.output as Schema<any> | undefined,
      maxSteps: this.maxSteps,
      maxDepth: this.maxDepth,
      reasoning: this.reasoning,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      logErrors: params.logErrors ?? true,
      maxRunDurationMs: limit,
      contextWindow: params.contextWindow,
      prepareStep: params.prepareStep ? [params.prepareStep] : [],
    };
  }

  static create<
    const T extends readonly ToolEntry[],
    const S extends readonly Skill[],
    O extends Schema<any> | undefined = undefined,
  >(params: CreateAgentParams<T, S, O>): Agent<T, S, O> {
    if (params.output) {
      assertObjectRoot(params.output as Schema<any>, `The agent "${params.name}"`, "output");
    }
    if (params.maxRunDurationMs != null) {
      assertDuration(params.maxRunDurationMs, `The agent "${params.name}"`, "maxRunDurationMs");
    }
    return new Agent(params);
  }

  stream(params: AgentStreamParams): AgentRun<ToolShapesOf<T>, OutputOf<O>> {
    const config: RunConfig = {
      ...this.config,
      provider: params.provider ?? this.config.provider,
      maxSteps: params.maxSteps ?? this.config.maxSteps,
      reasoning: params.reasoning ?? this.config.reasoning,
      maxOutputTokens: params.maxOutputTokens ?? this.config.maxOutputTokens,
      temperature: params.temperature ?? this.config.temperature,
      maxRunDurationMs:
        params.maxRunDurationMs !== undefined
          ? normalizeDuration(params.maxRunDurationMs)
          : this.config.maxRunDurationMs,
      contextWindow:
        params.contextWindow === false
          ? undefined
          : (params.contextWindow ?? this.config.contextWindow),
      prepareStep: params.prepareStep
        ? [...this.config.prepareStep, params.prepareStep]
        : this.config.prepareStep,
    };
    if (params.maxRunDurationMs != null) {
      assertDuration(
        params.maxRunDurationMs,
        `Agent.stream for "${this.name}"`,
        "maxRunDurationMs",
      );
    }
    return new AgentRunImpl(config, params) as unknown as AgentRun<ToolShapesOf<T>, OutputOf<O>>;
  }
}

export type OutputOf<O> = O extends Schema<any> ? Infer<O> : never;

export type AnyAgent = Agent<any, any, any>;

// --- lowering ------------------------------------------------------------

function toolSpec(resolved: ResolvedTool): ProviderToolSpec {
  const schema = resolved.inputSchema;
  return {
    name: resolved.tool.name,
    description: resolved.tool.description,
    // A per-run schema is not known yet; the run swaps this spec for one built
    // from the resolved schema (`AgentRunImpl.resolveToolSchemas`) before the
    // provider ever sees it.
    parameters: schema ? schema.toJSONSchema() : EMPTY_PARAMETERS,
    // Read off the schema, not asserted: an input containing an `s.json()`
    // field cannot be sent strict, and the tool that says so is the only place
    // that knows.
    strict: schema ? supportsStrict(schema) : true,
    deferred: resolved.deferred,
  };
}

/** The tool's schema when it is fixed, `undefined` when it is resolved per run. */
function staticInputSchema(tool: AnyAgentTool): Schema<any> | undefined {
  return typeof tool.inputSchema === "function" ? undefined : tool.inputSchema;
}

/**
 * Flattens the declared tuple into the registry the loop dispatches on, and the
 * shape the provider is shown.
 *
 * Both are built once, at `Agent.create`, because neither depends on the
 * request: a tool is a singleton and a namespace is a static grouping. Building
 * them per run would be work repeated on every turn for an answer that cannot
 * change — and it would move the name-collision errors below out of startup and
 * into the first user's first message.
 */
function lowerTools(
  entries: readonly ToolEntry[],
  skills: readonly Skill[],
): {
  registry: Map<string, ResolvedTool>;
  providerTools: (ProviderToolSpec | ProviderToolNamespace)[];
} {
  const registry = new Map<string, ResolvedTool>();
  const providerTools: (ProviderToolSpec | ProviderToolNamespace)[] = [];

  const register = (resolved: ResolvedTool) => {
    if (registry.has(resolved.tool.name)) {
      throw new Error(
        `Two tools are named "${resolved.tool.name}". Tool names are global within an agent — the client discriminates a tool part by name alone.`,
      );
    }
    registry.set(resolved.tool.name, resolved);
  };

  for (const entry of entries) {
    if (entry instanceof ToolNamespace) {
      if (entry.name === SKILLS_NAMESPACE) {
        throw new Error(
          `"${SKILLS_NAMESPACE}" is reserved for the namespace skills are lowered into. Rename the namespace — silently shadowing it would make every skill unreachable with no error to read.`,
        );
      }
      const members: ProviderToolSpec[] = [];
      for (const tool of entry.tools) {
        const resolved = {
          tool,
          namespace: entry.name,
          deferred: entry.deferred || tool.deferred,
          inputSchema: staticInputSchema(tool),
        };
        register(resolved);
        members.push(toolSpec(resolved));
      }
      providerTools.push({ name: entry.name, description: entry.description, tools: members });
      continue;
    }
    const resolved = {
      tool: entry,
      deferred: entry.deferred,
      inputSchema: staticInputSchema(entry),
    };
    register(resolved);
    providerTools.push(toolSpec(resolved));
  }

  if (skills.length > 0) {
    const members: ProviderToolSpec[] = [];
    for (const skill of skills) {
      const tool = skillTool(skill);
      register({
        tool,
        namespace: SKILLS_NAMESPACE,
        deferred: false,
        inputSchema: staticInputSchema(tool),
      });
      members.push({
        name: skill.name,
        description: skill.description,
        parameters: EMPTY_PARAMETERS,
        strict: true,
        // Not deferred: the whole cost of a skill in the prompt is its name and
        // description, and those are exactly what deferral keeps. Withholding
        // an empty parameter object saves nothing and adds a round trip.
        deferred: false,
      });
    }
    providerTools.push({
      name: SKILLS_NAMESPACE,
      description: SKILLS_NAMESPACE_DESCRIPTION,
      tools: members,
    });
  }

  return { registry, providerTools };
}

/** The zero-parameter tool a skill becomes. */
function skillTool(skill: Skill): AnyAgentTool {
  return AgentTool.create({
    name: skill.name,
    description: skill.description,
    inputSchema: {
      toJSONSchema: () => EMPTY_PARAMETERS,
      parse: () => ({}),
      safeParse: () => ({ ok: true as const, value: {} }),
    } as unknown as Schema<Record<string, never>>,
    // The thunk is called here, on load, and not at startup: a skill body can
    // be a megabyte of markdown, and an agent that declares twelve of them
    // should not read twelve files to answer "hello".
    execute: async () => {
      const body =
        typeof skill.instructions === "function" ? await skill.instructions() : skill.instructions;
      const sections = [body];
      for (const file of skill.files ?? []) {
        sections.push(`--- ${file} ---\n${await readSkillFile(file)}`);
      }
      return sections.join("\n\n");
    },
  }) as unknown as AnyAgentTool;
}

async function readSkillFile(file: string): Promise<string> {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    // A missing file is told to the model rather than thrown: the rest of the
    // skill is still worth having, and a run should not die because one of
    // several appendices moved.
    return `(could not be read: ${(error as Error).message})`;
  }
}

// --- the run -------------------------------------------------------------

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncGenerator).next === "function" &&
    Symbol.asyncIterator in (value as object)
  );
}

type StepOutcome = {
  reason: FinishReason;
  error?: AgentError;
  /** The HTTP response behind `error`, when the provider reported one. */
  detail?: { status?: number; requestId?: string };
};

/**
 * The prior transcript plus what a later run produced, upserted by id.
 *
 * A run only reports the messages it *made*, so a resumed sub-run's
 * `result().messages` is the tail and not the whole thing — and a message it
 * amended (the one holding the call that was finally answered) comes back under
 * an id the prior transcript already has. Appending would duplicate it and
 * replacing the array would lose everything before the resume, so the record on
 * `ToolCallPart.nested` is rebuilt by upsert, which is the same rule a store
 * keyed by message id follows.
 */
function mergeMessages(prior: AgentMessage[], produced: AgentMessage[]): AgentMessage[] {
  const merged = [...prior];
  const index = new Map(merged.map((message, at) => [message.id, at]));
  for (const message of produced) {
    const at = index.get(message.id);
    if (at === undefined) {
      index.set(message.id, merged.length);
      merged.push(message);
    } else {
      merged[at] = message;
    }
  }
  return merged;
}

/** Tool calls in a transcript with no result anywhere in it. */
function openCallIds(messages: AgentMessage[]): Set<string> {
  const resolved = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-result") resolved.add(part.toolCallId);
    }
  }
  const open = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call" && !resolved.has(part.toolCallId)) open.add(part.toolCallId);
    }
  }
  return open;
}

/**
 * A sub-agent's structured answer, read back out of its transcript.
 *
 * `NestedRun` has nowhere to put an `output` — it is a transcript, and the
 * output part is already in it — so a memoized run recovers the value the same
 * way a client would. That keeps the memo honest: what a replay returns is
 * derived from what was persisted, not from a second copy that could disagree
 * with it.
 */
function outputOf(messages: AgentMessage[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part.type === "output" && part.partial !== true) return part.value;
    }
  }
  return undefined;
}

/** For the replay-mismatch message, where the label is what tells two runs of
 *  the same agent apart. */
function describeRun(agent: string, label: string | undefined): string {
  return label === undefined ? `"${agent}"` : `"${agent}" labelled "${label}"`;
}

/** A message flattened to text, for comparing one turn's seed against another's. */
function textOfMessage(message: AgentMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
    .join("");
}

/**
 * What a `runAgent` call would start its sub-run from, as a comparable string.
 *
 * `null` when the call names no seed at all — `runAgent(agent, {})` — which is
 * the one shape with nothing to compare against, since the record's first
 * message would then be something the sub-agent said rather than something it
 * was told.
 */
function seedOf(params: RunAgentParams): string | null {
  if (params.prompt !== undefined) return `user:${params.prompt}`;
  const first = params.messages?.[0];
  return first ? `${first.role}:${textOfMessage(first)}` : null;
}

// Moved to `contextWindow.ts`, which splits a thread into turns with it, and
// re-exported here for the controller and the tests that import it from here.
export { injectedMessageIds };

/**
 * How many tool-produced files stay attached to the request. See
 * `AgentRunImpl.historyForProvider`, which is where the reasoning lives.
 */
const SHOWN_FILE_WINDOW = 1;

/**
 * Why the Nth attachment of a replayed tool body is not the Nth attachment of
 * the turn that escalated, or `null` when it is.
 *
 * DELIBERATELY WEAKER THAN `replayMismatch`, and the reason is what each of them
 * is protecting. A crossed sub-run pairs a human's answer with a question they
 * never saw, which is consent applied to the wrong thing and is invisible
 * afterwards; a crossed attachment shows the model the wrong picture, which is
 * wrong and is also the sort of wrong the next turn can talk its way out of. So
 * this checks the two things that cannot change for an honest reason and
 * nothing else.
 *
 * Not the size, and not any digest of the bytes: the body that produced this
 * blob ran again from the top and produced it again, and almost nothing that
 * makes an image — a model, a renderer with a timestamp in it, a compressor
 * with a thread pool — is byte-identical twice. Comparing bytes would fail the
 * common case and catch the rare one.
 *
 * Not the name either, for a smaller version of the same reason: filenames
 * carry dates and counters, and an app that names its output
 * `chart-${Date.now()}.png` would find its tool broken on every resume.
 *
 * What is left is the media type and whether the caller asked to show it, which
 * is exactly what changes when a body takes a different branch — the CSV path
 * instead of the PNG path, the quiet `put` instead of the `showModel` one.
 */
function putMismatch(
  recorded: ToolAttachmentPut,
  blob: Blob,
  params: PutAttachmentParams,
): string | null {
  const mimeType = params.mimeType || blob.type || "";
  if (mimeType && recorded.attachment.mimeType !== mimeType) {
    return (
      `was ${JSON.stringify(recorded.attachment.mimeType)} on the turn that escalated ` +
      `and is ${JSON.stringify(mimeType)} on the replay`
    );
  }
  const shown = Boolean(params.showModel);
  if (shown !== Boolean(recorded.shown)) {
    return shown
      ? "was stored without showModel on the turn that escalated and asks for showModel on the replay"
      : "was stored with showModel on the turn that escalated and asks for a plain put on the replay";
  }
  return null;
}

/**
 * Why the Nth sub-run of a replayed tool body is not the Nth sub-run of the
 * turn that escalated, or `null` when it is.
 *
 * Agent and label catch the branchy shape. THE SEED IS WHAT CATCHES THE SHAPE
 * THE DOC COMMENT NAMES FIRST: `runAgent` in a loop, the same agent every time,
 * no label — the default and the common case — over a list that came back in a
 * different order, from a `Set`, a re-sorted query, or a second read of a
 * mutable column. Agent and label match for every element of such a loop, so
 * without this the user's answer to the second question is folded into the run
 * the tool now believes is the first, and the model is told the crossed pair as
 * fact. Nothing in the transcript, the stream or the store shows it happened.
 *
 * The record's first message is the seed because `runNested` records it that
 * way — the user turn built from `prompt`, or the first of `params.messages`.
 * `instructions` is not compared: it never enters the transcript, and
 * `NestedRun` has nowhere to keep it.
 */
function replayMismatch(
  recorded: NestedRun,
  agent: AnyAgent,
  params: RunAgentParams,
): string | null {
  if (recorded.agent !== agent.name || recorded.label !== params.label) {
    return (
      `was ${describeRun(recorded.agent, recorded.label)} on the turn that escalated ` +
      `and is ${describeRun(agent.name, params.label)} on the replay`
    );
  }
  const seed = seedOf(params);
  const first = recorded.messages[0];
  const was = first ? `${first.role}:${textOfMessage(first)}` : null;
  if (seed !== null && was !== null && seed !== was) {
    return (
      `was started with ${JSON.stringify(was)} on the turn that escalated ` +
      `and with ${JSON.stringify(seed)} on the replay`
    );
  }
  return null;
}

/**
 * What is left of an answer's path once this run's own prefix is removed.
 *
 * `null` means the answer is not addressed to this run at all, which is a
 * client error rather than a routing decision — an empty remainder means "a
 * call this run made itself", and a non-empty one names the tool call to
 * re-enter.
 */
function pathBelow(path: string[] | undefined, prefix: string[]): string[] | null {
  const full = path ?? [];
  if (full.length < prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) {
    if (full[i] !== prefix[i]) return null;
  }
  return full.slice(prefix.length);
}

/**
 * The one memo rule a re-entered tool body plays by, in one place.
 *
 * A tool that escalates cannot be suspended — a paused async generator does not
 * fit in a message history — so it is re-entered FROM THE TOP on the next turn
 * and everything it did the first time has to be recognised rather than done
 * again. The only key available is the order the calls happened in, and the only
 * place a record can live is the message history, because that is the sole state
 * that crosses a turn boundary in a thread and in the browser alike.
 *
 * So: an array on the `ToolCallPart`, a snapshot of its length taken before the
 * body runs (everything already there came from an earlier turn and is
 * replayable; everything appended past that point is happening for the first
 * time), and an index that walks it. `ctx.runAgent` and `ctx.attachments.put`
 * both need exactly this and they share it here rather than each growing their
 * own copy — the failure of two copies is that one of them is fixed and the
 * other is not, and both are invisible until someone resumes.
 *
 * The array is created by the first WRITE and not before. `nested: []` or
 * `attachments: []` on every tool call would be a wire and store change paid for
 * by every app that has neither — and "on first use" is not good enough, because
 * a slot is handed out before the work that fills it can fail. A tool whose only
 * `put` throws (no attachment scope, a provider that cannot read files) must
 * leave a tool call with no `attachments` field, not an empty array announcing
 * an attachment that does not exist.
 *
 * A SLOT IS RESERVED WHEN IT IS ASKED FOR, THOUGH, NOT WHEN IT IS FILLED, and
 * that is deliberate: a tool body may run its `put`s or its `runAgent`s
 * concurrently — `await Promise.all(images.map((i) => ctx.attachments.put(i)))`
 * is the obvious way to write it — and every one of them takes its index
 * synchronously, in map order, before its first `await`. Handing out the index
 * on success instead would number them by the order they *finished*, which the
 * network decides and which the next turn will not reproduce. So the index
 * always advances, and a slot whose work threw stays unwritten.
 *
 * An unwritten slot before a written one would be a hole, and a hole is `null`
 * once it goes through JSON — which is what a consumer walking `part.attachments`
 * would crash on. `fill` is what stands in its place. `runAgent` passes none, so
 * `nested` keeps exactly the shape it has had since sub-agents existed, holes
 * and all: `NestedRun` describes a sub-run that happened and has no honest shape
 * for one that did not, and inventing one is a change to nesting rather than to
 * the issue this memo was extracted for.
 *
 * What is NOT shared is what to do with a hit, and it could not be: a recorded
 * sub-run that parked has to be *continued*, so `runAgent`'s memo sometimes
 * returns and sometimes falls through, while a recorded `put` is total — the
 * bytes are already stored and the id is already in the transcript the model
 * read, so there is nothing left to finish. The drift check differs too, and for
 * a reason worth reading: see `replayMismatch` against the note on
 * `putMismatch`.
 */
class ReplayMemo<R> {
  private index = 0;
  private readonly replayable: number;

  constructor(
    private readonly read: () => R[] | undefined,
    private readonly create: () => R[],
    /** What stands in for a slot whose work threw. See the note above. */
    private readonly fill?: () => R,
  ) {
    this.replayable = read()?.length ?? 0;
  }

  /**
   * The next slot: its index, the record a previous turn left there if it left
   * one, and the way to write this turn's.
   *
   * `write` is the only thing that touches the array. Call it once the record
   * exists and not before — everything between `next()` and `write()` is work
   * that may throw, and a slot nobody writes is a slot that costs nothing.
   */
  next(): { at: number; recorded: R | undefined; write: (record: R) => void } {
    const at = this.index++;
    return {
      at,
      recorded: at < this.replayable ? this.read()?.[at] : undefined,
      write: (record: R) => {
        const rows = this.read() ?? this.create();
        if (this.fill) {
          for (let i = rows.length; i < at; i++) rows[i] = this.fill();
        }
        rows[at] = record;
      },
    };
  }
}

class AgentRunImpl implements AgentRun<ToolShapes, unknown> {
  readonly runId: string;

  /** Replaced once, by `resolveToolSchemas`, when the agent has per-run tool schemas. */
  private config: RunConfig;
  private readonly params: AgentStreamParams;
  /** `params.context`, or `{}` for a run started without one. See `AgentContext`. */
  private readonly context: AgentContext;
  private readonly controller = new AbortController();

  private readonly buffer: AgentStreamFrame<ToolShapes, unknown>[] = [];
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  private ended = false;

  /** The working history handed to the provider, and what this run produced. */
  private history: AgentMessage[] = [];
  /** How the previous model call ended, for `prepareStep`. */
  private lastStep: { reason: FinishReason; usage?: Usage } | undefined;
  private produced: AgentMessage[] = [];
  private current: AgentMessage | null = null;
  /**
   * Whether a step of the message now open ran out of output budget.
   *
   * Separate from `finishReason` because they are different facts: a step that
   * hits the ceiling and also calls a tool closes its message `awaiting-input` or
   * `max-steps`. Cleared as each message is finalized.
   */
  private outputTruncated = false;

  /** Messages from an earlier run this one has amended, by id. Cloned once and
   *  reused, so two results for the same message do not fork it. */
  private readonly amended = new Map<string, AgentMessage>();
  /**
   * Messages this run finished outside `finalizeMessage` that have not yet gone
   * through `onMessage`: earlier turns' messages it amended, and messages it
   * injected for a file a tool showed.
   *
   * They wait rather than being reported where they are made, because
   * `onMessage` is the persistence point for an app that has no `store` and an
   * append-only table keyed by a serial id reads back in the order the hook was
   * called. Reporting an injected message from inside `runTools` would call the
   * hook for it BEFORE the assistant message whose tool call produced it, since
   * that message is only finalized once the step is over — so the transcript in
   * the app's database would put the file above the turn that made it, while
   * `result.messages`, the stream and `history` all put it below.
   */
  private readonly unreported = new Set<AgentMessage>();

  private usage: Usage = emptyUsage();
  private finishReason: FinishReason = "stop";
  /** Set by `fail`, and only there: the cause of a run that ends `"error"`. */
  private failure: AgentRunFailure | undefined;
  private output: unknown;
  private stopReason: string | undefined;
  /**
   * The limit that stopped this run, when it was `maxRunDurationMs` rather
   * than `stop()` that did. Read by the abort path, which is shared: a run that
   * ran out of time is closed exactly like a stopped one, and only its finish
   * reason and its `error` differ.
   */
  private timedOutAfter: number | undefined;
  /** Clears the `maxRunDurationMs` timer. A no-op for a run without one. */
  private cancelDeadline: () => void = () => {};

  private readonly settled: Promise<AgentRunResult<ToolShapes, unknown>>;

  /**
   * Where this run sits in a tree of runs, all of it constant for the run.
   *
   * `signingRunId` is the *root's* id rather than this one's: the client only
   * ever sees the root run, so a question a sub-agent asks has to travel under
   * an id the client can hand back. `pathPrefix` is the chain of tool calls
   * above this run, and it is both what a pending call raised here is signed
   * over and what an answer coming back is matched against.
   */
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly chain: string[];
  private readonly signingRunId: string;
  private readonly pathPrefix: string[];
  private readonly onPending: "escalate" | "deny";
  /**
   * Sub-runs that have not yet written their transcript to the tool call.
   *
   * The abort path waits on these. A `stop()` reaches a sub-run through the
   * shared signal, so it is already closing — but `raceAbort` in `runTools`
   * returns the moment the signal fires, which would finalize and persist the
   * parent's message before the sub-run had recorded what it managed to do.
   * The work would be on the stream and missing from the store.
   */
  private readonly nestedSettling = new Set<Promise<unknown>>();
  /**
   * Messages for files a tool asked to show, held until its call settles, keyed
   * by tool call id. See `queueShown`.
   */
  private readonly shownQueue = new Map<string, AgentMessage[]>();

  constructor(config: RunConfig, params: AgentStreamParams) {
    this.config = config;
    this.params = params;
    // Cast because an app whose `AgentContext` has required fields makes `{}`
    // unassignable here — and such an app cannot reach this default, since
    // `ContextParam` makes it pass one.
    this.context = params.context ?? ({} as AgentContext);
    this.runId = params.runId ?? `run_${crypto.randomUUID()}`;
    this.history = [...params.messages];

    const nesting = params.nesting;
    this.depth = nesting?.depth ?? 0;
    this.maxDepth = nesting?.maxDepth ?? config.maxDepth;
    this.chain = nesting?.chain ?? [config.name];
    this.signingRunId = nesting?.signingRunId ?? this.runId;
    this.pathPrefix = nesting?.signingPath ?? [];
    this.onPending = nesting?.onPending ?? "escalate";

    if (params.signal) {
      if (params.signal.aborted) this.controller.abort();
      else params.signal.addEventListener("abort", () => this.stop(), { once: true });
    }

    // The root's default, not a sub-run's: a sub-run shares its parent's
    // signal, so the parent's deadline already reaches it, and a default of its
    // own would cut short a parent that was deliberately given longer.
    const limit =
      config.maxRunDurationMs !== undefined
        ? config.maxRunDurationMs
        : nesting
          ? null
          : DEFAULT_MAX_RUN_DURATION_MS;
    this.cancelDeadline = startTimer(limit, () => this.expire(limit!));

    // Started here, not on first read. A run outlives the request that began
    // it, so nothing may depend on someone being attached — a client that
    // never reads still gets its tools run and its messages persisted.
    this.settled = this.execute();
    // And a request that started it stays open until it settles. A tool may
    // still read ambient request state — `Auth.user()`, a policied query — and
    // a client that leaves mid-run cancels the response body without stopping
    // the run; ending the request there would take the user away from step
    // four's tool call. Read ambiently rather than from a param because a run
    // need not come from a request at all: in a job or a script there is no
    // store, and nothing to hold open.
    RequestContext.getStore()?.waitUntil(this.settled);
  }

  // --- event plumbing ----------------------------------------------------

  private emit(event: AgentStreamEvent<ToolShapes, unknown>) {
    if (this.ended) return;
    this.buffer.push({ seq: ++this.seq, event });
    this.wake();
  }

  private wake() {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const resolve of pending) resolve();
  }

  private nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.add(resolve));
  }

  /**
   * Replays from the buffer, then follows the run live.
   *
   * The whole run is buffered rather than a sliding window: a run is bounded by
   * `maxSteps`, and a client that reconnects two steps late wanting frame 42
   * must get frame 42 and not "the oldest I still have". Bounding it is the
   * live-run registry's job, where the policy question is how long a *finished*
   * run is kept.
   */
  async *frames(from = 0): AsyncIterable<AgentStreamFrame<ToolShapes, unknown>> {
    let index = from > 0 ? from - 1 : 0;
    for (;;) {
      while (index < this.buffer.length) {
        yield this.buffer[index++];
      }
      if (this.ended) return;
      await this.nextFrame();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentStreamEvent<ToolShapes, unknown>> {
    for await (const frame of this.frames()) {
      yield frame.event;
    }
  }

  toResponse(params?: { from?: number }): Response {
    const frames = this.frames(params?.from);
    const encoder = new TextEncoder();
    let cancelled = false;

    let keepalive!: ReturnType<typeof sseKeepalive>;

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // A slow tool or a thinking sub-agent can leave the connection silent
        // for longer than a proxy's idle timeout, and a proxy that closes it
        // looks to the client exactly like a run that finished.
        keepalive = sseKeepalive(controller);
        try {
          for await (const frame of frames) {
            if (cancelled) break;
            // `id:` carries the cursor so a browser reconnecting with
            // `Last-Event-ID` is already asking the right question.
            controller.enqueue(
              encoder.encode(`id: ${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`),
            );
            keepalive.touch();
          }
        } catch {
          // A stream that cannot be written to is a dead reader, not a dead
          // run. Nothing to report and nothing to stop.
        }
        keepalive.stop();
        try {
          controller.close();
        } catch {
          // already closed by a cancel
        }
      },
      cancel: () => {
        // Deliberately does not touch the run. A disconnect is a reader
        // leaving; `stop()` is the only thing that cancels work, because the
        // tool loop is here and a closed tab has not stopped step four from
        // charging a card.
        cancelled = true;
        keepalive.stop();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Tells nginx not to buffer, which would otherwise hold every frame
        // until the response ended and make a stream look like a long pause.
        "X-Accel-Buffering": "no",
      },
    });
  }

  result(options?: AgentResultOptions): Promise<AgentRunResult<ToolShapes, unknown>> {
    if (!options?.throwOnError) return this.settled;
    return this.settled.then((result) => {
      if (result.error) throw new AgentRunError({ ...result, error: result.error });
      return result;
    });
  }

  stop(params?: { reason?: string }): void {
    if (this.ended || this.controller.signal.aborted) return;
    this.stopReason = params?.reason;
    this.controller.abort();
  }

  /**
   * `maxRunDurationMs` ran out. Stopped through the same controller as
   * `stop()`, so everything that already honours a stop (the provider request,
   * `raceAbort` around the tools, `ctx.signal`, sub-runs) honours this too.
   * The difference is only in how the run ends: see `finalizeAborted`.
   */
  private expire(limit: number): void {
    if (this.ended || this.controller.signal.aborted) return;
    this.timedOutAfter = limit;
    this.stopReason = `The run reached its time limit of ${formatDuration(limit)} and was stopped.`;
    this.controller.abort(new DOMException(this.stopReason, "TimeoutError"));
  }

  // --- the loop ----------------------------------------------------------

  private async execute(): Promise<AgentRunResult<ToolShapes, unknown>> {
    this.emit({ type: "run-start", runId: this.runId, threadId: this.params.threadId });

    try {
      // First, because everything after it reads a tool's schema: re-entering
      // a parked call below validates its input, and the model is shown them.
      const unresolved = await this.resolveToolSchemas();
      // A turn that answers a sub-agent's question re-enters the tool that
      // asked it, and that tool may ask again — so the run can be finished
      // before it has taken a single model step. Going on to `loop()` here
      // would step the model with a tool call still open, which is exactly the
      // history the provider rejects.
      const escalated = unresolved ? [] : await this.ingestTurn();
      if (unresolved) {
        this.fail(unresolved);
        this.finishReason = "error";
      } else if (escalated.length > 0) {
        this.finishReason = "awaiting-input";
        this.emit({ type: "awaiting-input", runId: this.runId, pending: escalated });
      } else {
        await this.loop();
      }
    } catch (error) {
      if (error instanceof RunAborted || this.controller.signal.aborted) {
        await this.finalizeAborted();
      } else {
        this.fail(this.config.provider.normalizeError(error), httpErrorDetail(error));
        await this.finalizeMessage("error");
        this.finishReason = "error";
      }
    }
    this.cancelDeadline();

    this.emit({ type: "usage", usage: this.usage });
    this.emit({ type: "run-end", runId: this.runId, finishReason: this.finishReason });
    this.ended = true;
    this.wake();

    const failure = this.finishReason === "error" ? this.failure : undefined;
    if (failure && this.config.logErrors) this.logFailure(failure);

    return {
      runId: this.runId,
      messages: this.produced as AgentMessage<ToolShapes, unknown>[],
      finishReason: this.finishReason,
      usage: this.usage,
      output: this.output,
      // Only when there is one, so a successful result has the same keys it
      // always had.
      ...(failure ? { error: failure } : {}),
    };
  }

  /**
   * Resolves the per-run input schemas (`ToolInputSchema`'s function form) and
   * swaps them into this run's registry and provider tool list. A no-op for
   * an agent whose tool schemas are all fixed, which is the common case.
   *
   * Returns the run's error when a resolver throws or returns a schema the
   * provider cannot take; the caller fails the run with it. Its message names
   * the tool and the cause — server-side only, since the client's copy is
   * redacted like any `tool_error`. The run fails before the turn is ingested,
   * so a client turn it carried is not reported to `onMessage`.
   */
  private async resolveToolSchemas(): Promise<AgentError | undefined> {
    const pending = [...this.config.registry.values()].filter((entry) => !entry.inputSchema);
    if (pending.length === 0) return undefined;
    const ctx: ToolSchemaContext = {
      context: this.context,
      body: this.params.body ?? {},
      runId: this.runId,
      threadId: this.params.threadId,
      signal: this.controller.signal,
    };
    const schemas = new Map<string, Schema<any>>();
    const failures = await Promise.all(
      pending.map(async (entry) => {
        try {
          const resolve = entry.tool.inputSchema as (
            ctx: ToolSchemaContext,
          ) => Schema<any> | Promise<Schema<any>>;
          const schema = await resolve(ctx);
          assertObjectRoot(schema, `The tool "${entry.tool.name}"`, "inputSchema");
          schemas.set(entry.tool.name, schema);
          return undefined;
        } catch (error) {
          return `"${entry.tool.name}": ${error instanceof Error ? error.message : String(error)}`;
        }
      }),
    );
    if (this.controller.signal.aborted) throw new RunAborted();
    const failed = failures.filter((failure) => failure !== undefined);
    if (failed.length > 0) {
      return {
        code: "tool_error",
        message: `Could not resolve the input schema of ${failed.join("; ")}`,
        retryable: false,
      };
    }

    const registry = new Map<string, ResolvedTool>();
    for (const [name, entry] of this.config.registry) {
      registry.set(name, schemas.has(name) ? { ...entry, inputSchema: schemas.get(name) } : entry);
    }
    const swap = (spec: ProviderToolSpec): ProviderToolSpec =>
      schemas.has(spec.name) ? toolSpec(registry.get(spec.name)!) : spec;
    const providerTools = this.config.providerTools.map((tool) =>
      "tools" in tool ? { ...tool, tools: tool.tools.map(swap) } : swap(tool),
    );
    this.config = { ...this.config, registry, providerTools };
    return undefined;
  }

  /**
   * Records why the run is failing and puts the client's copy on the stream.
   *
   * The two are built apart on purpose. `failure` is the server's record —
   * what `result().error` returns and what is logged — and carries the HTTP
   * status and request id of the provider's response, when there was one.
   * The frame gets the redacted copy (`redact`): the `AgentError` fields
   * only, named one by one so a field added to `AgentRunFailure` cannot reach
   * a browser by accident, and a message gemi did not write replaced (#446).
   */
  private fail(error: AgentError, detail: { status?: number; requestId?: string } = {}): void {
    const failure: AgentRunFailure = { ...error, ...detail };
    this.failure = failure;
    this.emit({ type: "error", error: this.redact(failure, { source: "run", failure }) });
  }

  /**
   * The one place an error is redacted for the client, through the app's
   * `redactError` or the default. The original is remembered against the
   * copy so the controller's `onError`, which hears the frame in this
   * process, still gets the full detail.
   */
  private redact(error: AgentError, info: Parameters<ErrorRedactor>[1]): AgentError {
    const redacted = applyRedaction(this.params.redactError, error, info, (err) =>
      this.writeLog(`[gemi/ai] agent "${this.config.name}" redactError threw`, { error: err }),
    );
    rememberUnredacted(redacted, error);
    return redacted;
  }

  /**
   * Through the app's logger, so it lands in `storage/logs` and `onLogCreated`.
   *
   * Outside an application — a script, a test, a run started before boot —
   * there is no logger to resolve, and `Log.error` throws on the lookup. That
   * case falls back to `console.error` rather than being dropped, since the
   * point of this is that a failed run is never silent. In development it goes
   * to the console as well, because `gemi dev` does not print the log file and
   * the terminal is where a developer is looking.
   */
  private logFailure(failure: AgentRunFailure): void {
    const message = `[gemi/ai] agent "${this.config.name}" run failed (${failure.code}${
      failure.status !== undefined ? ` ${failure.status}` : ""
    }): ${failure.message}`;
    this.writeLog(message, { error: failure });
  }

  /**
   * A tool that threw something other than a `ToolError`. The model and the
   * client are only told that it failed (see `redactError`), so this is the
   * one place its message and stack survive.
   */
  private logToolFailure(call: ToolCallPart, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    this.writeLog(
      `[gemi/ai] agent "${this.config.name}" tool "${String(call.name)}" threw: ${text}`,
      { toolCallId: call.toolCallId, error },
    );
  }

  private writeLog(message: string, extra: Record<string, unknown>): void {
    const metadata = {
      agent: this.config.name,
      runId: this.runId,
      ...(this.params.threadId ? { threadId: this.params.threadId } : {}),
      ...(this.depth > 0 ? { chain: this.chain } : {}),
      ...extra,
    };
    let logged = false;
    try {
      Log.error(message, metadata);
      logged = true;
    } catch {
      // No application to resolve a logger from. Reported below instead.
    }
    if (!logged || process.env.NODE_ENV === "development") {
      console.error(message, metadata);
    }
  }

  private async loop(): Promise<void> {
    const maxSteps = Math.max(1, this.config.maxSteps);

    for (let step = 1; step <= maxSteps; step++) {
      const message = this.startMessage();
      const outcome = await this.runStep(message, step);
      this.lastStep = { reason: outcome.reason, usage: message.usage };

      if (outcome.error) {
        this.fail(outcome.error, outcome.detail);
        await this.finalizeMessage("error");
        this.finishReason = "error";
        return;
      }

      const calls = message.content.filter(
        (part): part is ToolCallPart => part.type === "tool-call",
      );

      if (calls.length === 0) {
        this.finishReason = outcome.reason;
        await this.finalizeMessage(outcome.reason);
        return;
      }

      const pending = await this.runTools(message, calls, step);

      if (pending.length > 0) {
        // The message closes first, then the run says what it is waiting for:
        // `awaiting-input` is terminal, and everything needed to answer it has
        // to already be on the stream when it arrives.
        this.finishReason = "awaiting-input";
        await this.finalizeMessage("awaiting-input");
        this.emit({ type: "awaiting-input", runId: this.runId, pending });
        return;
      }

      if (step === maxSteps) {
        // Not an exception. An agent that will not stop calling tools is a bug
        // the app has to be able to see and show, and a throw here would put it
        // in a log instead of in the transcript.
        this.finishReason = "max-steps";
        await this.finalizeMessage("max-steps");
        return;
      }

      await this.finalizeMessage(outcome.reason);
    }
  }

  private startMessage(): AgentMessage {
    const message: AgentMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      content: [],
      createdAt: new Date().toISOString(),
    };
    this.current = message;
    this.history.push(message);
    this.produced.push(message);
    this.emit({ type: "message-start", messageId: message.id, role: "assistant" });
    return message;
  }

  private async finalizeMessage(reason: FinishReason): Promise<void> {
    const message = this.current;
    if (!message) return;
    this.current = null;
    // Read and cleared together: it describes the message being closed, and the
    // next one starts with no opinion.
    const outputTruncated = this.outputTruncated;
    this.outputTruncated = false;
    message.finishReason = reason;
    // On the message and not only on the frame. The frame reaches a live client,
    // which is half the audience: `onMessage` persists this object and
    // `result().messages` hands it back, and a transcript restored through
    // `useChat({ initialMessages })` has nothing else to read. `finishReason`
    // cannot answer it — a step that ran out of budget while calling a tool
    // closes `awaiting-input`, which is the case this exists for.
    if (outputTruncated) message.outputTruncated = true;
    // Before the message is handed to `onMessage` to be persisted and before it
    // reaches `result()` — the two places it stops being written and starts
    // being kept. Every exit lands here, aborted and errored runs included.
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") {
        if (typeof part.text === "string") part.text = resolveRope(part.text);
      }
    }
    this.emit({
      type: "message-end",
      messageId: message.id,
      finishReason: reason,
      // Only when true, so the frame an ordinary message ends with is unchanged.
      ...(outputTruncated ? { outputTruncated: true as const } : {}),
      // The model call's usage for this message alone (#467). Absent when the
      // call never reported one — aborted mid-stream, or a provider that sent
      // no terminal frame — rather than a zero that reads as "free".
      ...(message.usage ? { usage: message.usage } : {}),
    });
    await this.report(message);
    // After it, never before: a file a tool showed during this message belongs
    // below the message whose tool call produced it, in the hook exactly as it
    // is in `result().messages` and on the stream. Empty on every step of a run
    // with no such file, which is most of them.
    await this.reportDeferred();
  }

  private async report(message: AgentMessage): Promise<void> {
    if (!this.params.onMessage) return;
    try {
      await this.params.onMessage(message);
    } catch {
      // Persistence failing must not take the transcript with it: the messages
      // are still on the stream and still in `result()`.
    }
  }

  // --- one model call ----------------------------------------------------

  private async runStep(message: AgentMessage, step: number): Promise<StepOutcome> {
    const signal = this.controller.signal;
    const provider = this.config.provider;

    const request = await this.prepareRequest(message, step);
    if ("error" in request) return { reason: "error", error: request.error };

    let outcome: StepOutcome = { reason: "stop" };
    const partialArgs = new Map<string, { name: string; args: string; namespace?: string }>();
    // Searches the model ran in this step, waiting for the call that follows
    // them. See `ToolCallPart.toolSearches` for why they are kept at all.
    let searches: ToolSearchRecord[] = [];
    const takeSearches = (): { toolSearches?: ToolSearchRecord[] } => {
      if (searches.length === 0) return {};
      const taken = searches;
      searches = [];
      return { toolSearches: taken };
    };
    let outputText = "";

    const stream = provider.stream({
      // Not `this.history` directly: an image a tool showed is in the history
      // forever and must not be in every *request* forever, and a long thread
      // is cut to the context window. See `prepareRequest`.
      messages: request.messages,
      systemPrompt: request.instructions,
      tools: this.config.providerTools.length > 0 ? this.config.providerTools : undefined,
      output: this.config.output ? outputFormat(this.config.output) : undefined,
      reasoning: this.config.reasoning,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      signal,
    });

    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await raceAbort(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      const event = next.value;

      switch (event.type) {
        case "text-delta": {
          appendText(message, "text", event.delta);
          this.emit({ type: "text-delta", messageId: message.id, delta: event.delta });
          break;
        }
        case "reasoning-delta": {
          appendReasoning(message, event.id, event.delta);
          this.emit({
            type: "reasoning-delta",
            messageId: message.id,
            delta: event.delta,
            id: event.id,
          });
          break;
        }
        case "output-delta": {
          outputText += event.delta;
          this.emit({
            type: "output-delta",
            messageId: message.id,
            delta: event.delta,
            snapshot: bestEffortParse(outputText),
          });
          break;
        }
        case "tool-search": {
          searches.push({
            namespaces: event.namespaces,
            loaded: event.loaded,
            ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
          });
          this.emit({ type: "tool-search", loaded: event.loaded });
          break;
        }
        case "tool-call-delta": {
          const held: { name: string; args: string; namespace?: string } = partialArgs.get(
            event.toolCallId,
          ) ?? { name: event.name, args: "" };
          held.args += event.argsDelta;
          held.name = event.name || held.name;
          held.namespace = event.namespace || held.namespace;
          partialArgs.set(event.toolCallId, held);
          this.emit({
            type: "tool-call",
            messageId: message.id,
            part: {
              type: "tool-call",
              toolCallId: event.toolCallId,
              name: held.name,
              input: bestEffortParse(held.args),
              partial: true,
              ...(held.namespace ? { namespace: held.namespace } : {}),
            },
          });
          break;
        }
        case "tool-call": {
          const namespace = event.namespace || partialArgs.get(event.toolCallId)?.namespace;
          partialArgs.delete(event.toolCallId);
          const part: ToolCallPart = {
            type: "tool-call",
            toolCallId: event.toolCallId,
            name: event.name,
            // A raw string when the model produced something that is not JSON.
            // Keeping it is what makes the `invalid_tool_input` result below
            // readable instead of an empty object nobody can explain.
            input: parseArgs(event.args),
            // Both are for the provider, which has to replay the call the way
            // the model made it (#776).
            ...(namespace ? { namespace } : {}),
            ...takeSearches(),
          };
          message.content.push(part);
          this.emit({ type: "tool-call", messageId: message.id, part });
          break;
        }
        case "finish": {
          this.usage = addUsage(this.usage, event.usage);
          // This step's own cost, on the message the step wrote (#467). The run
          // total above is the whole turn — every step plus tools' sub-runs,
          // `generate()` calls and images — and putting it on the last message
          // showed a three-step run's every token on step three. Added rather
          // than assigned in case a provider ever closes a call with more than
          // one finish frame.
          message.usage = addUsage(message.usage ?? emptyUsage(), event.usage);
          // The usage is taken either way, the reason only if nothing has
          // already failed. A provider is allowed to report an error and then
          // close the call with a finish frame — a content filter does exactly
          // that, and it still bills for the tokens — and letting the closing
          // frame overwrite the outcome would turn "blocked" into an empty
          // answer with no explanation anywhere.
          if (!outcome.error) outcome = { reason: event.reason };
          break;
        }
        case "error": {
          outcome = {
            reason: "error",
            error: event.error,
            detail: httpErrorDetail(event),
          };
          break;
        }
        case "file-rejected": {
          this.markFileRejected(event.fileId, event.message, httpErrorDetail(event));
          break;
        }
      }
    }

    // A tool call whose arguments never finished arriving. It is still a call
    // the model made, so it gets a part and, below, an `invalid_tool_input`
    // result — dropping it would leave the model unable to see what went wrong.
    for (const [toolCallId, held] of partialArgs) {
      const part: ToolCallPart = {
        type: "tool-call",
        toolCallId,
        name: held.name,
        input: parseArgs(held.args),
        ...(held.namespace ? { namespace: held.namespace } : {}),
        ...takeSearches(),
      };
      message.content.push(part);
      this.emit({ type: "tool-call", messageId: message.id, part });
    }

    // `length` is excluded, and it is the reason `maxOutputTokens` is worth
    // having at all. A cut-off answer is a prefix of the JSON the model meant
    // to write, and `bestEffortParse` closes whatever brackets are open — so a
    // truncated document arrives at `safeParse` looking like a whole one. For
    // a schema of `s.json()` fields it then *passes*, and the app is handed a
    // half-written page with nothing to distinguish it from a finished one.
    //
    // So a run that hit the ceiling produces no `output` part and ends with
    // `finishReason: "length"`, which is the channel for "not an error, and not
    // a finished answer" — the argument `max-steps` already makes in the
    // `FinishReason` type.
    //
    // No error is emitted, and that is a deliberate change rather than a
    // consequence of the cap. `length` does not mean the app set one: the
    // provider reports it from the model's own ceiling too, which is how this
    // was reachable before `maxOutputTokens` existed at all. Before this, a
    // truncated run fell through to `safeParse`, and a schema with required
    // keys among the missing ones failed it and raised a schema-mismatch error.
    // That diagnostic is gone on purpose — it described the truncation as a
    // model mistake, and it never fired for a schema loose enough to accept the
    // repaired prefix, which is the case that actually needed saying. What
    // replaces it is one answer for every schema: no output, and a finish
    // reason that says why.
    const truncated = outcome.reason === "length";
    // Recorded on the run rather than inferred from the message's finish reason,
    // which is not this: a step that hits the ceiling and also calls a tool ends
    // the message `awaiting-input` or `max-steps`. The client needs the fact
    // itself, or it completes a partial output the server withheld.
    if (truncated) this.outputTruncated = true;
    if (this.config.output && outputText && !outcome.error && !truncated) {
      const parsed = parseOutput(this.config.output, outputText);
      if (parsed.ok === true) {
        this.output = parsed.value;
        message.content.push({ type: "output", value: parsed.value });
      } else {
        this.emit({ type: "error", error: parsed.error });
      }
    }

    return outcome;
  }

  /**
   * What one model call is sent: the history as `historyForProvider` shapes
   * it, cut to `contextWindow`, then whatever the `prepareStep` hooks answer.
   *
   * Nothing here touches `this.history`. The hooks are handed copies of the
   * arrays, and what they answer is used for this call only, so the next step
   * starts from the whole history again and the store is never told about a
   * window.
   */
  private async prepareRequest(
    current: AgentMessage,
    step: number,
  ): Promise<{ messages: AgentMessage[]; instructions: string | undefined } | { error: AgentError }> {
    const history = this.historyForProvider(current);
    let messages = this.config.contextWindow
      ? windowMessages(history, this.config.contextWindow).messages
      : history;
    let instructions = await this.systemPrompt();

    for (const hook of this.config.prepareStep) {
      let answer: PrepareStepResult | void;
      try {
        answer = await hook({
          step,
          messages: [...messages],
          history: [...history],
          instructions,
          usage: this.usage,
          ...(this.lastStep?.usage ? { lastStepUsage: this.lastStep.usage } : {}),
          ...(this.lastStep ? { lastFinishReason: this.lastStep.reason } : {}),
          runId: this.runId,
          threadId: this.params.threadId,
          agent: this.config.name,
          depth: this.depth,
          context: this.context,
          signal: this.controller.signal,
        });
      } catch (error) {
        if (error instanceof RunAborted || this.controller.signal.aborted) throw error;
        const text = error instanceof Error ? error.message : String(error);
        return {
          error: { code: "unknown", message: `prepareStep threw: ${text}`, retryable: false },
        };
      }
      if (!answer) continue;
      if (answer.messages !== undefined) {
        if (!Array.isArray(answer.messages)) {
          return {
            error: {
              code: "unknown",
              message: "prepareStep answered `messages` that is not an array.",
              retryable: false,
            },
          };
        }
        messages = answer.messages;
      }
      if (answer.instructions !== undefined) instructions = answer.instructions || undefined;
    }

    return { messages, instructions };
  }

  private async systemPrompt(): Promise<string | undefined> {
    const parts = [this.config.instructions, this.params.instructions].filter(
      (part): part is string => Boolean(part && part.trim()),
    );
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  // --- tools -------------------------------------------------------------

  private async runTools(
    message: AgentMessage,
    calls: ToolCallPart[],
    step: number,
  ): Promise<PendingToolCall[]> {
    const pending: PendingToolCall[] = [];
    const running: Promise<void>[] = [];

    for (const call of calls) {
      const resolved = this.config.registry.get(String(call.name));

      if (!resolved) {
        this.addResult(message, {
          type: "tool-result",
          toolCallId: call.toolCallId,
          name: call.name,
          status: "error",
          error: {
            code: "tool_error",
            message: `There is no tool named "${String(call.name)}".`,
            toolCallId: call.toolCallId,
            retryable: true,
          },
        });
        continue;
      }

      const parsed = resolved.inputSchema!.safeParse(call.input);
      if (parsed.ok === false) {
        // Back to the model, not up the stack. A model that mis-typed one
        // argument can usually fix it on the next step, and throwing turns a
        // recoverable mistake into a dead run.
        this.addResult(message, {
          type: "tool-result",
          toolCallId: call.toolCallId,
          name: call.name,
          status: "error",
          error: {
            code: "invalid_tool_input",
            message: `Invalid arguments for "${String(call.name)}": ${parsed.errors.join(", ")}`,
            toolCallId: call.toolCallId,
            retryable: true,
          },
        });
        continue;
      }

      // The parsed value replaces the raw arguments on the part, and from here
      // on it is the only input this call has.
      //
      // A schema normalizes — it fills defaults, coerces, and drops the `null`s
      // that strict mode forces a model to send for an omitted optional. So
      // `safeParse(input)` and `input` are different values, and a pending call
      // has to be signed over, shown as, verified against and executed with the
      // *same* one. Keeping the raw value in the transcript and signing the
      // parsed one meant the MACs could not match on the way back: every
      // approval of a tool with an optional field came back looking forged, and
      // the user who clicked Approve was told they had refused.
      //
      // Writing it here rather than re-parsing on the way back also avoids
      // assuming `safeParse` is idempotent — the history now carries the value
      // the signature covers, so verification is a comparison and not a second
      // guess at what the first parse produced.
      call.input = parsed.value;

      const kind = pendingKind(resolved.tool);
      if (kind) {
        if (this.onPending === "deny") {
          this.addResult(message, this.deniedByPolicy(call));
          continue;
        }
        pending.push({
          toolCallId: call.toolCallId,
          name: call.name,
          input: parsed.value,
          kind,
          signature: signPendingCall(
            this.claimsFor(call.toolCallId, String(call.name), kind, parsed.value),
          ),
          ...(this.pathPrefix.length > 0 ? { path: [...this.pathPrefix] } : {}),
        });
        continue;
      }

      running.push(
        this.executeTool(resolved, message.id, call, parsed.value, step)
          .then(async (result) => {
            this.addResult(message, result);
            // The call has settled. Anything it asked to show goes into the
            // history now, after its own result — which is the order the
            // provider validates and the order it happened in.
            await this.settleShown(call.toolCallId);
          })
          .catch((error) => {
            if (error instanceof PendingEscalation) {
              if (this.onPending === "deny") {
                this.addResult(message, this.deniedByPolicy(call));
                return;
              }
              // Collected exactly like a pending call this run made itself, and
              // deliberately without a result on `call`: the tool did not
              // finish, so its call stays open and the next turn re-enters it.
              // Siblings are untouched — `Promise.all` below still waits for
              // them, and one that completes keeps its result rather than being
              // thrown away because a different tool asked a question.
              pending.push(...error.pending);
              return;
            }
            // Only `RunAborted` reaches here, and the abort path denies every
            // unresolved call at once — swallowing it keeps a stopped run from
            // also raising an unhandled rejection.
          }),
      );
    }

    await raceAbort(
      Promise.all(running).then(() => undefined),
      this.controller.signal,
    );
    return pending;
  }

  /**
   * What a pending call is signed over.
   *
   * `signingRunId` is the root run's, not this one's: the client only ever sees
   * the root, so a sub-agent's question has to be minted under an id the client
   * can hand back and this run can still recognise on the way in.
   */
  private claimsFor(
    toolCallId: string,
    name: string,
    kind: "approval" | "question" | "client",
    input: unknown,
  ) {
    return {
      runId: this.signingRunId,
      toolCallId,
      name,
      kind,
      input,
      // Absent rather than empty at the top level, so the signature a root run
      // mints is byte-for-byte the one it minted before nesting existed.
      path: this.pathPrefix.length > 0 ? [...this.pathPrefix] : undefined,
      // The principal the question is asked of (#447): an answer presented by
      // anyone else fails the MAC.
      subject: this.params.subject ?? null,
    };
  }

  /**
   * The refusal a sub-run running under `onPending: "deny"` gives itself.
   *
   * Told to the model rather than dropped, like every other denial: the
   * sub-agent asked for something it cannot have here, and the next step goes
   * better for knowing that than for finding a hole where a result should be.
   */
  private deniedByPolicy(call: ToolCallPart): ToolResultPart {
    return {
      type: "tool-result",
      toolCallId: call.toolCallId,
      name: call.name,
      status: "denied",
      cause: "refused",
      reason: `"${String(call.name)}" needs the user, and this run was started with onPending: "deny". Answer from what you already have.`,
    };
  }

  private async executeTool(
    resolved: ResolvedTool,
    messageId: string,
    call: ToolCallPart,
    input: unknown,
    step: number,
    resume?: { answers: ClientToolResult[] },
  ): Promise<ToolResultPart> {
    const timeoutMs = resolved.tool.timeoutMs;
    if (timeoutMs === undefined) {
      return this.runToolBody(
        resolved,
        messageId,
        call,
        input,
        step,
        resume,
        this.controller.signal,
        () => false,
      );
    }

    // The call's own signal: the run's, plus this call's `timeoutMs`. Everything
    // the call starts is handed this one rather than the run's, so a timeout
    // cancels its image calls and sub-runs too, and the run's stop still
    // reaches them through it. The forwarding is never removed, so a stop
    // reaches whatever the call left running after it answered, exactly as it
    // does with the run's own signal.
    const callController = new AbortController();
    const runSignal = this.controller.signal;
    const forwardStop = () => callController.abort(runSignal.reason);
    if (runSignal.aborted) forwardStop();
    else runSignal.addEventListener("abort", forwardStop, { once: true });

    // Set once the call has answered, by either route. Whatever the body yields
    // after that belongs to a call the model has already been told about, and
    // must not reach the stream.
    let answered = false;
    const body = this.runToolBody(
      resolved,
      messageId,
      call,
      input,
      step,
      resume,
      callController.signal,
      () => answered,
    );

    let cancelTimer = () => {};
    const timedOut = new Promise<ToolResultPart>((resolve) => {
      cancelTimer = startTimer(timeoutMs, () => {
        const message = `"${String(call.name)}" did not finish within ${formatDuration(timeoutMs)} (timeoutMs: ${timeoutMs}) and was cancelled.`;
        callController.abort(new DOMException(message, "TimeoutError"));
        resolve({
          type: "tool-result",
          toolCallId: call.toolCallId,
          name: call.name,
          status: "error",
          error: { code: "timeout", message, toolCallId: call.toolCallId, retryable: true },
        });
      });
    });
    // A body that settles after the timeout has nobody to tell. Its rejection
    // (an `AbortError` from honouring the signal, usually) is swallowed here
    // rather than surfacing as an unhandled one.
    body.catch(() => {});
    try {
      return await Promise.race([body, timedOut]);
    } finally {
      answered = true;
      cancelTimer();
    }
  }

  /** One call of a server tool, from `execute` to the result the model sees. */
  private async runToolBody(
    resolved: ResolvedTool,
    messageId: string,
    call: ToolCallPart,
    input: unknown,
    step: number,
    resume: { answers: ClientToolResult[] } | undefined,
    signal: AbortSignal,
    answered: () => boolean,
  ): Promise<ToolResultPart> {
    // One object, because the three of them share a memo — see `toolFiles`.
    const files = this.toolFiles(call, signal);
    const ctx: ToolContext = {
      context: this.context,
      // `{}` rather than undefined, so a tool can read a field without a guard
      // and get the same answer — absent — whether the client sent nothing or
      // the run was started without a body at all.
      body: this.params.body ?? {},
      runId: this.runId,
      threadId: this.params.threadId,
      toolCallId: call.toolCallId,
      signal,
      step,
      depth: this.depth,
      resumed: resume !== undefined,
      attachments: files.attachments,
      generateImage: files.generateImage,
      editImage: files.editImage,
      turn: this.toolTurn(messageId),
      runAgent: this.nestedRunner(messageId, call, signal, resume),
      generate: ((params: GenerateParams) =>
        this.generateForTool(params, signal, call.toolCallId)) as ToolContext["generate"],
    };

    try {
      const started = resolved.tool.execute!(input as any, ctx);
      let output: unknown;
      if (isAsyncGenerator(started)) {
        let next = await started.next();
        while (!next.done) {
          if (answered()) {
            // Timed out. Closed rather than drained: nothing it yields from
            // here can be shown, and a generator that is still being pulled
            // is one that keeps working.
            void started.return(undefined as never).catch(() => {});
            throw new RunAborted();
          }
          this.emit({ type: "tool-progress", toolCallId: call.toolCallId, data: next.value });
          next = await started.next();
        }
        output = next.value;
      } else {
        output = await started;
      }
      return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        name: call.name,
        status: "ok",
        output,
      };
    } catch (error) {
      if (error instanceof RunAborted || this.controller.signal.aborted) {
        // Left to the abort path, which denies every unresolved call at once.
        throw new RunAborted();
      }
      if (error instanceof PendingEscalation) {
        // The one throw that is not a failure. Turning it into a `tool_error`
        // here would tell the model the tool broke and tell the user nothing,
        // and the question the sub-agent asked would be lost with no trace of
        // where it went — which is precisely the silent failure this branch
        // exists to prevent.
        throw error;
      }
      // A throwing tool is a result, not an exception out of the run: the model
      // is told the call failed and can try something else, which is what a
      // person would do. What it is told is redacted (#446): the same part goes
      // to the model, to the client and into the store, and an exception's
      // message is whatever the code under the tool said, connection strings
      // and internal hostnames included. A `ToolError` is the tool saying its
      // message is meant to be read; anything else is logged in full here.
      const deliberate = error instanceof ToolError;
      if (!deliberate && this.config.logErrors) this.logToolFailure(call, error);
      const raw: AgentError = {
        code: "tool_error",
        message: error instanceof Error ? error.message : String(error),
        toolCallId: call.toolCallId,
        retryable: deliberate ? error.retryable : true,
      };
      return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        name: call.name,
        status: "error",
        error: this.redact(raw, { source: "tool", toolName: String(call.name), cause: error }),
      };
    }
  }

  /**
   * `ctx.generate`. See `ToolContext.generate` for why the binding matters.
   *
   * The usage is added before the abort check on purpose: a call cut short by
   * `stop()` may still have been billed for what it produced, and the turn's
   * total is the one place an app reads what the turn cost.
   */
  private async generateForTool(
    params: GenerateParams,
    callSignal: AbortSignal,
    toolCallId: string,
  ): Promise<GenerateResult<unknown>> {
    // `callSignal` is the tool call's `ctx.signal`: it aborts on a stop, at the
    // run's deadline, and at the tool's own `timeoutMs`. Only the first two
    // abort the turn (`controller.signal`), and only those throw below.
    const turn = this.controller.signal;
    return generateWithin(
      {
        ...params,
        signal: params.signal ? AbortSignal.any([callSignal, params.signal]) : callSignal,
      },
      {
        origin: {
          agent: this.config.name,
          runId: this.runId,
          ...(this.params.threadId ? { threadId: this.params.threadId } : {}),
          toolCallId,
        },
        // Before the failure is logged or thrown: the usage was billed either
        // way, and a stopped turn throws `RunAborted` rather than a
        // `throwOnError` rejection the tool might catch and carry on from.
        settled: (result) => {
          this.usage = addUsage(this.usage, result.usage);
          if (turn.aborted) throw new RunAborted();
        },
      },
    );
  }

  // --- nested runs -------------------------------------------------------

  /**
   * The `ctx.runAgent` given to one tool call, with its own memo.
   *
   * MEMOIZATION IS BY CALL INDEX, and the index is the only key there is. A
   * paused async generator cannot be put into a message history, so an
   * escalating tool is re-entered from the top rather than resumed in place,
   * and the Nth `runAgent` of the re-entered body has to be paired with the Nth
   * sub-run of the previous attempt. `ToolCallPart.nested` is that record, which
   * is also why it lives on the message: it is exactly the history the next turn
   * loads anyway, from the store or from the client.
   *
   * A tool whose `runAgent` calls sit inside a branch or a loop can produce a
   * different sequence on replay, and then index N means two different things.
   * That is checked below rather than trusted — pairing a user's answer with the
   * wrong sub-run is the failure this whole mechanism exists to avoid, and it
   * would be invisible.
   */
  private nestedRunner(
    messageId: string,
    call: ToolCallPart,
    signal: AbortSignal,
    resume?: { answers: ClientToolResult[] },
  ): ToolContext["runAgent"] {
    // Snapshotted before the tool body runs, and lazily created on first use.
    // Both rules, and the reasoning behind them, are on `ReplayMemo` — which
    // `ctx.attachments.put` shares, so that the two memos on one tool call
    // cannot drift apart in how they decide what is a replay.
    const memo = new ReplayMemo<NestedRun>(
      () => call.nested,
      () => (call.nested = []),
    );

    return async (agent: AnyAgent, params: RunAgentParams = {}): Promise<NestedRunResult> => {
      const { at, recorded, write } = memo.next();

      if (recorded) {
        const mismatch = replayMismatch(recorded, agent, params);
        if (mismatch) {
          throw new ToolError(
            `Nested run ${at} of "${String(call.name)}" ${mismatch}. ` +
              `runAgent is memoized by call index, so a body whose runAgent calls depend on a condition that changed between turns cannot be resumed — the answer would be paired with a different sub-run. ` +
              `Make the sequence of runAgent calls, and what each one is asked, the same every time this tool runs, or branch on ctx.resumed.`,
          );
        }
        if (recorded.finishReason !== "awaiting-input") {
          // The whole point of the memo: no provider is called, no sub-tool
          // runs, and no usage is counted a second time — this turn did not
          // spend it, an earlier one did.
          return {
            runId: recorded.runId,
            agent: recorded.agent,
            messages: recorded.messages,
            finishReason: recorded.finishReason ?? "stop",
            usage: recorded.usage ?? emptyUsage(),
            output: outputOf(recorded.messages),
            nested: recorded,
          };
        }
      }

      return this.runNested(
        messageId,
        call,
        signal,
        agent,
        params,
        write,
        recorded,
        resume?.answers ?? [],
      );
    };
  }

  /**
   * Starts, or continues, one sub-run and joins it to this one.
   *
   * Joining is the only reason this exists — a tool can already make an agent
   * and iterate it. What it cannot do by hand is put the sub-run's events on
   * this run's stream in this run's `seq`, roll its usage up, record its
   * transcript where the next turn will look for it, and carry the depth and
   * the name chain so a cycle is a sentence rather than a stack overflow.
   */
  private async runNested(
    messageId: string,
    call: ToolCallPart,
    signal: AbortSignal,
    agent: AnyAgent,
    params: RunAgentParams,
    write: (record: NestedRun) => void,
    recorded: NestedRun | undefined,
    answers: ClientToolResult[],
  ): Promise<NestedRunResult> {
    // Both checks before anything starts, so the failure is a tool result the
    // model can read rather than a partly-run tree. The name chain catches the
    // common cycle (A runs A, A runs B runs A) exactly; the depth limit catches
    // the shapes a name cannot see, such as the same agent under two names.
    const chain = [...this.chain, agent.name];
    if (this.chain.includes(agent.name)) {
      throw new ToolError(
        `"${agent.name}" is already running further up this chain: ${chain.join(" -> ")}. An agent cannot run itself, directly or through another agent.`,
      );
    }
    const depth = this.depth + 1;
    if (depth > this.maxDepth) {
      throw new ToolError(
        `Nested agent runs are ${this.maxDepth} deep at most and this one would be ${depth}: ${chain.join(" -> ")}. Raise maxDepth on the agent at the root of the run if the tree is meant to be this deep.`,
      );
    }

    const label = params.label;
    const signingPath = [...this.pathPrefix, call.toolCallId];
    // Inherited downwards and never relaxed: a caller that asked for an
    // autonomous sub-agent must not have a question surface from two levels
    // below it, and only the subtree refusing can promise that.
    const onPending = this.onPending === "deny" ? "deny" : (params.onPending ?? "escalate");

    const resuming = recorded !== undefined;
    const open = resuming ? openCallIds(recorded.messages) : new Set<string>();
    // Only the answers this sub-run can actually attach to a call of its own,
    // or route further down. Handing it the rest would make it report a result
    // for a call nobody made.
    const mine = resuming
      ? answers.filter((answer) => {
          const below = pathBelow(answer.path, signingPath);
          if (below === null) return false;
          return open.has(below.length > 0 ? below[0] : answer.toolCallId);
        })
      : [];

    const sub = agent.stream({
      // A resume starts from what was persisted, not from what the tool passed
      // this time: the body ran again from the top and rebuilt its `prompt`,
      // and honouring it would replay a first turn the sub-agent has already
      // had. The persisted transcript already contains it.
      messages: resuming ? recorded.messages : (params.messages ?? []),
      turn: resuming ? { toolResults: mine } : params.prompt ? { text: params.prompt } : undefined,
      // The same caller, so the same context. See `ToolContext.context`.
      context: this.context,
      // The same scope, down the whole tree. A sub-agent runs on behalf of the
      // caller who started the parent — that is the only reason it is allowed
      // to run at all — so it reads and writes the caller's attachments, and a
      // tool three levels down can be handed an id its parent parked. There is
      // nothing to widen here and nothing to narrow: a second scope would be a
      // second answer to a question the request already answered once.
      attachments: this.params.attachments,
      // Inherited for the same reason the scope above is: a sub-agent is part
      // of the turn its parent is serving, so the fields the client sent with
      // that turn are as much its context as the parent's. A generator run
      // through `runAgent` whose tools could not see `pageId` would have to be
      // passed it through the prompt, as text, for the model to copy back.
      body: this.params.body,
      // Inherited, not new: this is what makes the parent's `stop()` reach a
      // sub-run three levels down without anything in between forwarding it.
      // The call's signal rather than the run's: it is the run's plus the
      // tool's own `timeoutMs`, so a tool that times out takes its sub-runs
      // with it instead of leaving them to finish for nobody.
      signal,
      threadId: this.params.threadId,
      // The same caller is reading, so the same rules for what it is told.
      redactError: this.params.redactError,
      // The same store, so a sub-run's answers are single-use across every
      // instance exactly as the parent's are.
      nonces: this.params.nonces,
      // And the same receipts, so a sub-agent's approved tool runs once too.
      receipts: this.params.receipts,
      // The same principal, so a sub-agent's question is bound to the user the
      // root run was started for.
      subject: this.params.subject,
      instructions: params.instructions,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      // Kept across turns so the transcript the client already has keeps its
      // identity when the run continues.
      runId: resuming ? recorded.runId : undefined,
      nesting: {
        depth,
        maxDepth: this.maxDepth,
        chain,
        signingRunId: this.signingRunId,
        signingPath,
        onPending,
      },
    }) as AgentRun;

    let asked: PendingToolCall[] = [];
    const forward = (event: AgentStreamEvent) =>
      this.emit({
        type: "nested-event",
        toolCallId: call.toolCallId,
        runId: sub.runId,
        agent: agent.name,
        label,
        event,
      });
    const forwarding: Promise<void> = (async () => {
      for await (const event of sub as AsyncIterable<AgentStreamEvent>) {
        if (event.type === "awaiting-input") asked = event.pending;
        forward(event);
        if (event.type === "run-start" && !resuming) {
          // The seed, streamed (#470). It is recorded below as the head of the
          // transcript, but the sub-run never emits it — a run streams only the
          // messages it makes — so a client building the transcript from these
          // frames had none of it, while one that loaded the record (or got the
          // re-sent `tool-call`) did, and the two rendered different
          // conversations. Whole `message` frames, because the seed is finished
          // before the sub-run starts. A `prompt` is the sub-run's own turn and
          // is emitted by the sub-run itself (`ingestTurn`). A resume emits
          // nothing here: the record it continues already holds the seed.
          for (const message of params.messages ?? []) forward({ type: "message", message });
        }
        if (event.type === "error") {
          // Re-raised on the parent's own stream (#468). Wrapped in a
          // `nested-event` it reaches nobody: the client reduces it into a
          // throwaway sub-state, and the controller's hooks only hear
          // top-level frames, so `useChat.error`, `onError` and the
          // controller's `onError` never heard that a sub-agent failed. The
          // same object, not a copy: it was redacted by the sub-run already,
          // and the controller's `onError` finds the unredacted original by
          // identity. Not terminal — the tool decides what the failure means.
          this.emit({
            type: "error",
            error: event.error,
            nested: { toolCallId: call.toolCallId, runId: sub.runId, agent: agent.name },
          });
        }
      }
    })();

    // Recording is its own promise so that the abort path can wait for exactly
    // this — the transcript reaching the tool call — rather than for the whole
    // tool, which may be ignoring the signal.
    const recording = (async () => {
      const result = await sub.result();
      await forwarding;
      // The seed leads, because a run only reports the messages it *made* and
      // `params.messages` is not one of them. Recording the transcript without
      // its opening is two bugs: a resume re-enters the sub-agent with the
      // conversation it was started from missing, and the replay check below
      // has nothing to fingerprint the seed against. Upserted rather than
      // concatenated because the sub-run may have amended one of these on its
      // way through.
      const messages = resuming
        ? mergeMessages(recorded.messages, result.messages)
        : mergeMessages(params.messages ?? [], result.messages);
      const record: NestedRun = {
        runId: sub.runId,
        agent: agent.name,
        label,
        messages,
        finishReason: result.finishReason,
        usage: resuming ? addUsage(recorded.usage ?? emptyUsage(), result.usage) : result.usage,
        // A parked record is what the next turn re-enters the tool on, and in
        // stateless mode it comes back from the browser. Signed here, by the
        // run that knows it is true, over where the sub-run parked, what it is
        // waiting on and the input the tool was running with — `parkedBelow`
        // will not act on a record without it. `call.input` is the parsed
        // value by now, on every path that reaches here, so the transcript
        // carries exactly what was signed.
        ...(result.finishReason === "awaiting-input"
          ? {
              signature: signNestedRun({
                runId: this.signingRunId,
                path: signingPath,
                nestedRunId: sub.runId,
                open: [...openCallIds(messages)],
                input: call.input,
                subject: this.params.subject ?? null,
              }),
            }
          : {}),
      };
      // Written before anything below can throw. An escalation is a pause, not
      // a lost run, and a cancelled sub-run is still work the user should be
      // able to read — both of those depend on the transcript already being on
      // the part when the throw happens.
      write(record);
      // Only what this turn actually spent. A memoized sub-run adds nothing,
      // above, because the turn that ran it already counted it.
      this.usage = addUsage(this.usage, result.usage);
      return { result, record };
    })();

    const settling = recording.then(
      () => undefined,
      () => undefined,
    );
    this.nestedSettling.add(settling);
    let result: AgentRunResult<ToolShapes, unknown>;
    let record: NestedRun;
    try {
      ({ result, record } = await recording);
    } finally {
      this.nestedSettling.delete(settling);
    }

    if (this.controller.signal.aborted) {
      // The sub-run was cancelled by the parent's `stop()`. Failing the tool
      // rather than returning an aborted result is what stops the tool body
      // from carrying on with half an answer while the run around it is dying.
      throw new RunAborted();
    }

    if (result.finishReason === "awaiting-input") {
      if (asked.length === 0) {
        // Nothing to ask means nothing the client could answer, and escalating
        // an empty list would end the parent awaiting-input with a tool call
        // that can never be resolved.
        throw new ToolError(
          `"${agent.name}" ended awaiting input but asked nothing, so there is no question to escalate.`,
        );
      }
      // The signature is on the server's copy of the record, and a stateless
      // client has built its own from the forwarded events. Re-sending the
      // call is what puts the server's copy in the client's hands to carry
      // back: the reducer takes a re-sent `nested` as authoritative, so this
      // replaces what the client accumulated rather than adding to it. Marked
      // `resent` because it is not a call: the model made this one earlier —
      // in this run or, on a re-park, in a previous one — and a hook that
      // counts calls has already seen it.
      this.emit({ type: "tool-call", messageId, part: call, resent: true });
      throw new PendingEscalation({ pending: asked, path: signingPath, nested: record });
    }

    return {
      runId: record.runId,
      agent: agent.name,
      messages: record.messages,
      finishReason: result.finishReason,
      usage: record.usage ?? emptyUsage(),
      output: result.output ?? outputOf(record.messages),
      ...(result.error ? { error: result.error } : {}),
      nested: record,
    };
  }

  private addResult(message: AgentMessage, part: ToolResultPart) {
    message.content.push(part);
    this.emit({ type: "tool-result", messageId: message.id, part });
  }

  // --- files a tool made -------------------------------------------------

  /**
   * The `ctx.attachments` given to one tool call.
   *
   * Built per call rather than per run for one reason, and it is the same
   * reason `runAgent` is: the memo. A `put` has to be recognisable on the next
   * turn as the same `put`, and the only address a re-entered body has is "the
   * Nth attachment of this tool call" — so the object that counts them has to
   * belong to the call, not to the run.
   */
  /**
   * The file half of a tool's context: `ctx.attachments`, `ctx.generateImage`
   * and `ctx.editImage`.
   *
   * BUILT TOGETHER BECAUSE THEY SHARE ONE MEMO, and sharing it is not an
   * optimization. `ToolCallPart.attachments` is a list indexed by the order the
   * puts happened in, and a generated image *is* a put — so two `ReplayMemo`s
   * over the same list would each start at zero and hand out the same slots,
   * and a tool that both stored a file and generated one would replay the wrong
   * record for each. One list, one cursor.
   */
  private toolFiles(
    call: ToolCallPart,
    signal: AbortSignal,
  ): {
    attachments: ToolAttachments;
    generateImage: ToolContext["generateImage"];
    editImage: ToolContext["editImage"];
  } {
    const scoped = this.params.attachments ?? null;
    const memo = new ReplayMemo<ToolAttachmentRecord>(
      () => call.attachments,
      () => (call.attachments = []),
      // A put that threw took an index and wrote nothing, and if a later put in
      // the same call succeeds the gap has to be something rather than a hole:
      // `[null, { attachment }]` is what a hole becomes on the wire and in the
      // store, and it is what a UI or an app walking the memo crashes on. The
      // slot is re-attempted on a replay — `put` treats a failed record as no
      // record — so a transient failure heals itself on the turn the call
      // finally settles, and a permanent one stays legible as "this put did not
      // produce a file" instead of pretending it produced nothing at all.
      () => ({ failed: true }),
    );

    /**
     * The scope, or a sentence saying why there isn't one.
     *
     * A request with no subject gets no attachments at all — that is #489's
     * rule and this is where a tool meets it. The throw lands in `executeTool`,
     * which turns it into a `tool_error` the model reads, so the model is told
     * the tool cannot store files rather than being told nothing while the tool
     * quietly answers an id for bytes nobody kept. The message names the hook
     * an app has to override, because the reader who can act on it is the
     * developer looking at the transcript, not the model.
     */
    const scopeOrThrow = (): ScopedAttachments => {
      if (!scoped) {
        throw new InvalidAttachmentScopeError(
          "This request has no attachment scope, so a tool cannot store or read files on it. `attachmentScope()` returned null — put the chat route behind authentication, send a `threadId`, or override `attachmentScope()` on the controller.",
        );
      }
      return scoped;
    };

    /**
     * Everything a filled slot needs, with nothing of the memo in it.
     *
     * Shared by `put` and by the two image calls, which differ only in where the
     * bytes came from and in whether a `generated` record rides along. The
     * upload-then-store ordering, the `fileInput` refusal and the minted message
     * id are one copy for all three.
     */
    const park = async (
      blob: Blob,
      params: PutAttachmentParams,
      generated?: ToolAttachmentPut["generated"],
    ): Promise<ToolAttachmentPut> => {
      const attachments = scopeOrThrow();
      const mimeType = params.mimeType || blob.type || "";
      // A name is settled here rather than left to `ScopedAttachments.put`,
      // which falls back to the attachment id. The provider's upload wants a
      // filename, the injected `FilePart` carries one, and the stored record
      // has one — three copies that have to agree, so there is one value.
      const name = params.name ?? (blob instanceof File ? blob.name : "attachment");

      let fileId: string | undefined;
      if (params.showModel) {
        const provider = this.config.provider;
        if (!provider.capabilities.fileInput) {
          // Refused before a byte moves. `toResponsesInput` drops a file part
          // for a provider that cannot read one, so without this the tool
          // pays for an upload, stores a record claiming the model was shown
          // the file, and the model answers about an image that never reached
          // the wire — with nothing in the transcript, the logs or the bill
          // saying which of those three things went wrong.
          throw new ToolError(
            `"${String(call.name)}" asked to show a file to ${provider.model}, which does not accept file input. Drop \`showModel\` for this provider, or run this agent on a model that takes files — \`capabilities.fileInput\` is what says which do.`,
          );
        }
        // The provider first, storage second — the opposite of `upload`'s
        // order in `AgentController`, deliberately.
        //
        // That route stores first because either failure fails the request
        // and the only question is whose orphan it becomes. Here there is a
        // second question and it decides: the record this writes claims
        // `destination: "both"`, and a record cannot claim the vendor has a
        // copy before the vendor says so. Uploading first also means a file
        // the vendor refuses — a type it will not take, a size over its cap —
        // costs no storage write at all, and `showModel` is exactly the path
        // where that refusal is likeliest. The orphan when storage fails
        // afterwards is a file at the vendor with no record here, which is
        // the same orphan `AgentController.upload` accepts in the other
        // direction.
        fileId = await provider.upload(new File([blob], name, { type: mimeType || undefined }));
      }

      const attachment = await attachments.put(blob, { name, mimeType, fileId });
      return {
        attachment,
        ...(generated ? { generated } : {}),
        ...(fileId
          ? {
              shown: {
                fileId,
                // Minted here and written down, not derived later. The next
                // turn replays this record and has to produce the same
                // message — same id, same timestamp — or a reattached client
                // and a live one hold two copies of one image.
                messageId: `msg_${crypto.randomUUID()}`,
                createdAt: new Date().toISOString(),
              },
            }
          : {}),
      };
    };

    /**
     * A slot that was filled by a different call than the one asking for it now.
     *
     * The sequence of file calls inside a tool body is the memo's only key, so a
     * body that stored a file on the first attempt and generates one at the same
     * index on the replay has changed in a way nothing can reconcile — and the
     * failure without this check is silent and expensive: `generateImage` would
     * hand back an attachment nobody rendered, or `put` would return the id of a
     * generated image in place of the bytes it was given.
     */
    const assertKind = (recorded: ToolAttachmentPut, wanted: "put" | "image", at: number) => {
      const was = recorded.generated ? "image" : "put";
      if (was === wanted) return;
      throw new ToolError(
        `Attachment ${at} of "${String(call.name)}" was ${was === "image" ? "a generated image" : "a stored file"} on the first attempt and is ${wanted === "image" ? "a generated image" : "a stored file"} now. ` +
          `ctx.attachments.put, ctx.generateImage and ctx.editImage share one memo indexed by call order within a tool call, so the sequence has to be the same every time this tool runs. Branch on ctx.resumed if it cannot be.`,
      );
    };

    const runImage = async (
      model: ImageModel,
      params: ToolGenerateImageParams,
      render: () => Promise<GeneratedImage>,
    ): Promise<GeneratedAttachment> => {
      const { at, recorded, write } = memo.next();

      // Read BEFORE the render, which is the whole point of memoizing this
      // rather than letting it fall through to `ctx.attachments.put`. `put`
      // checks its memo when it is called, and by then the image has been
      // rendered and paid for — its own docblock says so: "Work before a `put`
      // still runs again." Here the expensive part is the work before.
      if (recorded && "attachment" in recorded) {
        assertKind(recorded, "image", at);
        if (recorded.shown) this.queueShown(call.toolCallId, recorded);
        return {
          attachment: recorded.attachment,
          size: recorded.generated!.size,
          mimeType: recorded.attachment.mimeType,
          usage: recorded.generated!.usage,
        };
      }

      const image = await render();
      // Counted against the run exactly as a nested agent's is, so
      // `AgentRunResult.usage` is the whole cost of the turn and not only its
      // text. `imageInputTokens` keeps the image share legible inside it.
      this.usage = addUsage(this.usage, image.usage);

      const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
      const record = await park(
        image.image,
        {
          name: params.name ?? `${model.name}.${extension}`,
          mimeType: image.mimeType,
          ...(params.showModel ? { showModel: true } : {}),
        },
        { size: image.size, usage: image.usage },
      );

      write(record);
      if (record.shown) this.queueShown(call.toolCallId, record);
      return {
        attachment: record.attachment,
        size: image.size,
        mimeType: image.mimeType,
        usage: image.usage,
      };
    };

    /** An attachment id resolves through the scope; bytes pass through. */
    const asInput = async (input: ImageInput | string): Promise<ImageInput> =>
      typeof input === "string" ? await scopeOrThrow().file(input) : input;

    return {
      generateImage: (model, params) =>
        runImage(model, params, () => model.generate({ ...params, signal })),

      editImage: (model, params) =>
        runImage(model, params, async () => {
          // `images` and `mask` are peeled off rather than spread over: both
          // may be attachment ids here and neither is one by the time it
          // reaches `ImageModel`, so letting the originals through would type
          // as `string | Blob` and ship an id where bytes belong.
          const { images, mask, ...rest } = params;
          return await model.edit({
            ...rest,
            images: (await Promise.all(images.map(asInput))) as [ImageInput, ...ImageInput[]],
            ...(mask ? { mask: await asInput(mask) } : {}),
            signal,
          });
        }),

      attachments: {
        get: (id: string) => scopeOrThrow().get(id),
        read: (id: string) => scopeOrThrow().read(id),
        file: (id: string) => scopeOrThrow().file(id),
        put: async (blob: Blob, params: PutAttachmentParams = {}): Promise<Attachment> => {
          const { at, recorded, write } = memo.next();

          // A `failed` record is a slot an earlier turn took and could not fill,
          // so there is nothing to replay and the work is done again.
          if (recorded && "attachment" in recorded) {
            assertKind(recorded, "put", at);
            const mismatch = putMismatch(recorded, blob, params);
            if (mismatch) {
              throw new ToolError(
                `Attachment ${at} of "${String(call.name)}" ${mismatch}. ` +
                  `ctx.attachments.put is memoized by call index within a tool call, so a body whose put calls depend on a condition that changed between turns cannot be replayed — the model would be shown a file under an id that names different bytes. ` +
                  `Make the sequence of put calls the same every time this tool runs, or branch on ctx.resumed.`,
              );
            }
            // Nothing is stored and nothing is uploaded. What IS repeated is the
            // queueing: the first attempt escalated before its result attached,
            // so the message was queued and never flushed, and this turn is the
            // one where the call finally settles. `settleShown` refuses a message
            // id the history already holds, which is what makes queueing twice
            // safe rather than merely unlikely.
            if (recorded.shown) this.queueShown(call.toolCallId, recorded);
            return recorded.attachment;
          }

          const record = await park(blob, params);
          // The slot is filled only now, with everything that could throw behind
          // it: a put that fails leaves the tool call exactly as it found it.
          write(record);
          if (record.shown) this.queueShown(call.toolCallId, record);
          return record.attachment;
        },
      },
    };
  }

  /**
   * The `ctx.turn` given to one tool call. The reasoning is on `ToolTurn`.
   *
   * Anchored on `messageId`, the assistant message holding the call, which is
   * the same id on a re-entry: `amend` replaces the history entry with a clone
   * under the original's id, so the lookup is by id rather than by reference.
   * A message that is not in the history at all gets an empty list rather than
   * a guess.
   */
  private toolTurn(messageId: string): ToolTurn {
    const at = this.history.findIndex((message) => message.id === messageId);
    const injected = injectedMessageIds(this.history);
    let user: AgentMessage | undefined;
    for (let i = at - 1; i >= 0; i--) {
      const message = this.history[i];
      if (message.role !== "user" || injected.has(message.id)) continue;
      user = message;
      break;
    }
    const ids: string[] = [];
    for (const part of user?.content ?? []) {
      if (part.type !== "file") continue;
      // The prefix test `providers/request.ts` applies before telling the model
      // an id. A stateless client's history can put anything here, and a value
      // the model was never shown as an id should not reach a tool as one.
      const id = part.attachmentId;
      if (typeof id !== "string" || !id.startsWith(ATTACHMENT_ID_PREFIX)) continue;
      if (!ids.includes(id)) ids.push(id);
    }
    return Object.freeze({ attachments: Object.freeze(ids) });
  }

  /**
   * Holds the message for a shown file until its tool call settles.
   *
   * WHY IT WAITS. The message is input-role and it has to sit *after* the tool
   * call's result, because that is the order it happened in and the order the
   * provider validates: a `function_call` and its `function_call_output` are a
   * pair, and a user message wedged between them is a history the API rejects.
   * Emitting it the moment `put` returns would do exactly that, since the tool
   * is still running.
   *
   * WHY A TOOL THAT ESCALATED GETS NOTHING. Its call has no result yet, so
   * flushing would leave an image in the transcript attached to a call that has
   * not finished — and the next turn re-enters the body, replays the `put` and
   * would queue a second copy. The queue simply dies with the run; the record
   * on the tool call survives, and the turn that finally settles the call is
   * the turn that shows the file.
   */
  private queueShown(toolCallId: string, record: ToolAttachmentPut) {
    const shown = record.shown;
    if (!shown) return;
    const queued = this.shownQueue.get(toolCallId) ?? [];
    if (queued.some((message) => message.id === shown.messageId)) return;
    queued.push({
      id: shown.messageId,
      role: "user",
      content: [
        {
          type: "file",
          fileId: shown.fileId,
          name: record.attachment.name,
          mimeType: record.attachment.mimeType,
          // Shown to the model beside the file (see `attachmentLine` in
          // `providers/request.ts`), so a file one tool made can be the input
          // of the next. Not what marks the part as injected — a user's upload
          // carries one too; `historyForProvider` keys on the message id.
          attachmentId: record.attachment.id,
        },
      ],
      createdAt: shown.createdAt,
      // Complete the instant it is made. Without this the client's `run-end`
      // safety net would find a message with no finish reason and stamp one on,
      // which is a difference between a live client and a reattached one over a
      // message that was never streaming in the first place.
      finishReason: "stop",
    });
    this.shownQueue.set(toolCallId, queued);
  }

  /**
   * The tool call settled: its files go into the transcript now.
   *
   * Pushed to `history` (so the next step sees them), to `produced` (so
   * `result().messages` carries them and the controller persists them), emitted
   * (so a client watching live sees the same conversation a reattached one
   * replays), and queued for `onMessage` (so an app that persists from the hook
   * stores it). A message that is in some of those four and not the others is
   * the bug class #470 is about, and an injected message is the easiest place in
   * the codebase to write it.
   *
   * QUEUED FOR THE HOOK RATHER THAN REPORTED HERE, so that all four agree on
   * ORDER and not merely on contents. The assistant message that made this tool
   * call has not been finalized yet — `loop` does that after `runTools`
   * returns — so calling `onMessage` from here would hand an app the file
   * before the turn that produced it. `reportDeferred` is where the queue is
   * drained, immediately after that assistant message is reported.
   *
   * The id guard is for a history that already holds the message — a stateless
   * client posting back a transcript that contains the injection *and* still
   * shows the call as open, which is a rewind the server cannot rule out. One
   * copy either way.
   *
   * NOTHING IS SHOWN ONCE THE RUN IS OVER, and the check belongs here rather than
   * at the three call sites because one of those sites fires after the run has
   * finished. `finalizeAborted` never calls this — it denies every open call
   * instead — but a `/stop` does not wait for a tool that is already running:
   * `raceAbort` in `runTools` returns the moment the signal fires, the run
   * finalizes and ends, and the tool's own `.then` lands afterwards and calls
   * this. Without the guard the message goes into `history` and `produced` and
   * through `onMessage` while `emit` is already a no-op, so it is persisted and
   * never announced, and a client that reloads the thread sees an image a client
   * that watched it live never saw. That is the exact divergence this issue
   * asked to avoid, arrived at from the one direction nobody looks. Appending an
   * image to a conversation the user has just cancelled would also be the run
   * getting the last word. The bytes are kept and the record is on the tool
   * call, so a tool that runs again can still resolve the id; nothing is lost
   * but the showing.
   */
  private async settleShown(toolCallId: string): Promise<void> {
    const queued = this.shownQueue.get(toolCallId);
    if (!queued || queued.length === 0) return;
    this.shownQueue.delete(toolCallId);
    if (this.ended || this.controller.signal.aborted) return;
    for (const message of queued) {
      if (this.history.some((held) => held.id === message.id)) continue;
      this.history.push(message);
      this.produced.push(message);
      this.emit({ type: "message", message });
      this.unreported.add(message);
    }
  }

  /**
   * The history as the provider sees it: everything, minus all but the most
   * recent tool-produced file.
   *
   * THE PROBLEM. `buildResponsesRequest` is handed the whole history on every
   * step, so a file injected at step two is re-sent at steps three, four and
   * five. An edit loop that iterates three times therefore pays for three
   * images on every later call — image tokens are not small, and they are
   * charged again each step — on top of one provider upload per iteration. Left
   * alone this is a cost that grows with the square of the loop and shows up on
   * an invoice rather than in a stack trace.
   *
   * WHAT IS TRIMMED, AND WHERE. Here, on the way to the provider, and nowhere
   * else. The transcript keeps every injected message: `history`, `produced`,
   * `onMessage`, the stream, and the client all hold the same conversation they
   * would have held without this method, so a `/attach` replay still matches a
   * live stream and a user scrolling back still sees every version the agent
   * made. Trimming the stored transcript instead would have meant editing a
   * message after it was persisted and announced, which is the one thing the
   * message contract does not allow.
   *
   * WHAT IT COSTS, AND IT IS A REAL CAPABILITY. With a window of one, the model
   * cannot compare this iteration against the last one. "Is this closer than
   * the previous attempt?" is a question it can no longer answer from what it
   * can see, and an agent whose job is to converge on a target by comparison
   * genuinely wants two. One is the default because the failure of too small a
   * window is visible and cheap — the model says it cannot see the earlier
   * image, in the transcript, on the first run — while the failure of too large
   * a one is a bill nobody reads until the end of the month. The dropped part
   * is replaced by a line of text rather than removed, so the model is told the
   * image existed and why it is gone; a hole would leave it to conclude it had
   * imagined seeing anything.
   *
   * IT IS A CONSTANT, NOT A KNOB, ON PURPOSE. A configurable window is one line
   * to add later and cannot be taken back once apps depend on it, and nobody
   * has a second value to name yet. Only files the run injected are counted —
   * a file the *user* attached is one they expect to stay attached, and
   * dropping it would be the agent losing the thing it was asked about.
   */
  private historyForProvider(current: AgentMessage): AgentMessage[] {
    const messages = this.history.filter((message) => message !== current);

    // Injected messages are named by the tool call that made them, and that
    // record is the test — not `attachmentId` on the part. A user's own upload
    // carries an `attachmentId` too: `ingestTurn` copies it from `turn.files`,
    // and `useChat` spreads the entry onto its local user message.
    const injected = injectedMessageIds(messages);

    const shown: FilePart[] = [];
    for (const message of messages) {
      if (!injected.has(message.id)) continue;
      for (const part of message.content) {
        if (part.type === "file") shown.push(part);
      }
    }
    if (shown.length <= SHOWN_FILE_WINDOW) return messages;

    const dropped = new Set(shown.slice(0, shown.length - SHOWN_FILE_WINDOW));
    return messages.map((message) => {
      if (!message.content.some((part) => part.type === "file" && dropped.has(part))) {
        return message;
      }
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "file" && dropped.has(part)
            ? {
                type: "text" as const,
                text: `[A ${part.mimeType || "file"} produced by a tool (attachment ${part.attachmentId}) was attached here and has been dropped from this request: only the most recent tool-produced file is kept attached, to keep the context bounded. Call the tool again if you need to look at it.]`,
              }
            : part,
        ),
      };
    });
  }

  // --- the client's turn -------------------------------------------------

  /**
   * Resolves what the client sent back, then adds its words.
   *
   * Every pending call has to come out of this with a result — signed, refused
   * or implicitly denied. The provider rejects a history holding a tool call
   * with no result, so leaving one open would break not this turn but the next
   * one, at a point where the cause is no longer visible.
   */
  private async ingestTurn(): Promise<PendingToolCall[]> {
    const turn = this.params.turn;
    const open = this.openCalls();
    /** Questions a re-entered tool asked again. The run ends on these. */
    const escalated: PendingToolCall[] = [];

    if (open.length > 0) {
      const answered = new Set<string>();
      const seen = new Set<string>();
      /** Answers addressed *below* one of this run's tool calls, grouped by the
       *  call that has to be re-entered to deliver them. */
      const reentry = new Map<string, ClientToolResult[]>();

      for (const answer of turn?.toolResults ?? []) {
        // One answer per call, first one wins. A turn carrying the same entry
        // twice is a retried submit or a double-clicked form, and without this
        // it ran the approved tool twice and left two results for one
        // toolCallId — a history the provider rejects, arrived at by exactly
        // the machinery that exists to keep the history well formed.
        //
        // Keyed by path *and* id, because a tool-call id is only unique within
        // one run: two sub-agents under two different tools each number their
        // calls from their own provider, and dropping the second as a duplicate
        // would strand the tool that was waiting on it. For a top-level answer
        // the key is the id, exactly as before.
        const key = `${(answer.path ?? []).join("/")}#${answer.toolCallId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const reject = (message: string) =>
          this.emit({
            type: "error",
            error: {
              code: "invalid_tool_result",
              message,
              toolCallId: answer.toolCallId,
              retryable: false,
            },
          });

        // The path says which run the answer belongs to; `toolCallId` only says
        // which call *within* that run. Both are covered by the signature, so a
        // client that moves an answer to another tool's sub-run does not
        // redirect anything — it routes the answer somewhere the MAC no longer
        // verifies, which is the property that makes carrying the path safe.
        const below = pathBelow(answer.path, this.pathPrefix);
        if (below === null) {
          reject(
            `The answer for "${answer.toolCallId}" is addressed to a tool call this run is not inside.`,
          );
          continue;
        }

        if (below.length > 0) {
          const host = below[0];
          const hosting = open.find((entry) => entry.call.toolCallId === host);
          if (!hosting) {
            reject(`No pending tool call with id "${host}" to deliver a nested answer to.`);
            continue;
          }
          // THE ONE CHECK THAT MAKES RE-ENTRY SAFE, and the reason it is here
          // rather than in `reenter`.
          //
          // Re-entry runs the tool. Everything else in this method verifies a
          // signature first, but a path cannot be verified here — the claims
          // are the *inner* call's, and only the run that minted them knows its
          // tool, its `kind` and its input, which is why `resolveAnswer` runs
          // down there and not up here. So the decision to execute has to be
          // gated on something the server derived instead: there must be a
          // sub-run parked on this exact call, and it must be waiting on the
          // exact question the answer names. Without this, a turn that posts
          // `{ path: [<any open call>], signature: "" }` re-enters a tool that
          // is merely awaiting an *approval* — running, unapproved, a call the
          // user was shown and never said yes to, with its input taken from a
          // client-carried history. Content is still checked below, in the
          // sub-run; this is what stops an unsigned request from choosing to
          // execute at all.
          const parked = this.parkedBelow(hosting.call, below, answer.toolCallId);
          if (parked.ok === false) {
            const under = `The answer for "${answer.toolCallId}" is addressed under "${host}", which`;
            reject(
              parked.reason === "unparked"
                ? `${under} has no sub-agent run waiting on that question.`
                : parked.reason === "expired"
                  ? `${under} parked a sub-agent run that has since expired. Ask again.`
                  : `${under} carries a record of a parked sub-agent run the server did not sign.`,
            );
            continue;
          }
          let group = reentry.get(host);
          if (!group) {
            // Spent here, ahead of the body, for the reason the record is
            // signed at all: re-entry runs the tool before the sub-run gets to
            // refuse a spent answer, so a history rewound to before the result
            // would run it once per replay. Once per record per turn — the
            // sub-run may have asked two things at once, and every answer to
            // it re-enters the same tool a single time.
            if (!(await this.spend(spendNestedRun, parked.signature))) {
              reject(
                `The answer for "${answer.toolCallId}" is addressed under "${host}", which has already been re-entered on that record. Ask again.`,
              );
              continue;
            }
            group = [];
            reentry.set(host, group);
            // Marked answered so the refusal pass below leaves it alone: the
            // tool is about to be re-entered and will produce the real result.
            answered.add(host);
          }
          group.push(answer);
          continue;
        }

        const target = open.find((entry) => entry.call.toolCallId === answer.toolCallId);
        if (!target) {
          // Nothing to attach it to, so it cannot be told to the model even as
          // an error part — a result for a call that was never made.
          reject(`No pending tool call with id "${answer.toolCallId}".`);
          continue;
        }

        const result = await this.resolveAnswer(target, answer, escalated);
        if (result === null) continue;
        answered.add(answer.toolCallId);
        // `"open"` is an approved tool whose own sub-agent asked something on
        // the way through: answered, so the refusal pass leaves it alone, but
        // no result attaches — the call stays open and the next turn re-enters
        // it, exactly as an escalation from the step loop does. Nothing it
        // showed is flushed either, for the same reason: the call has not
        // settled, so the file waits for the turn where it does.
        if (result !== "open") {
          this.attachToHistory(target, result);
          await this.settleShown(answer.toolCallId);
        }
      }

      for (const [host, answers] of reentry) {
        const entry = open.find((item) => item.call.toolCallId === host)!;
        const result = await this.reenter(entry, answers, escalated);
        if (result) {
          this.attachToHistory(entry, result);
          // The turn a re-entered tool finally settles on is the turn its files
          // are shown, however many turns ago it stored them.
          await this.settleShown(host);
        }
      }

      for (const entry of open) {
        if (answered.has(entry.call.toolCallId)) continue;
        // The turn said something else. That is a refusal — the honest reading,
        // and the only one that cannot strand the thread. A tool whose
        // sub-agent asked a question and did not get an answer is refused here
        // like any other: the sub-run is abandoned with its transcript intact,
        // and the call gets a result rather than dangling into the next turn.
        this.attachToHistory(entry, {
          type: "tool-result",
          toolCallId: entry.call.toolCallId,
          name: entry.call.name,
          status: "denied",
          cause: "refused",
        });
      }

      await this.reportDeferred();
    }

    if (turn && (turn.text || (turn.files && turn.files.length > 0))) {
      const message: AgentMessage = {
        id: `msg_${crypto.randomUUID()}`,
        role: "user",
        content: [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          // Field by field rather than spread: an entry can carry whatever
          // `attach()` answered (`downgraded`, `size`), and only these four
          // mean anything on a `FilePart`. `attachmentId` is among them — it is
          // what lets the model name this file to a tool — and an absent
          // `fileId` is a storage-only upload, left out rather than written as
          // `undefined`.
          ...(turn.files ?? []).map((file) => ({
            type: "file" as const,
            ...(file.fileId ? { fileId: file.fileId } : {}),
            name: file.name,
            mimeType: file.mimeType,
            ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
          })),
        ],
        createdAt: new Date().toISOString(),
        finishReason: "stop",
      };
      this.history.push(message);
      this.produced.push(message);
      // A sub-run's turn was written by the tool that started it, not typed by
      // the client watching, so nothing on the stream would ever tell that
      // client it exists (#470). A top-level turn is not echoed: the client
      // sent it and already has it. What it does not have is this id, so it is
      // told that alone, keyed by the id it gave its own copy (#466).
      if (this.depth > 0) this.emit({ type: "message", message });
      else if (turn.localId) {
        this.emit({ type: "message-id", localId: turn.localId, messageId: message.id });
      }
      await this.report(message);
    }

    return escalated;
  }

  /**
   * Whether a sub-run under `call` is actually parked on the question named.
   *
   * The transcript is the server's own record of where the run stopped:
   * `nested` is written from the sub-run's result before the escalation throws,
   * so a call that has never nested has no `nested` at all, and one whose
   * sub-runs all finished has none with `awaiting-input`. In stateless mode
   * that record arrives from the client and could say anything, and what
   * saying it buys is not small: the tool body runs — from the top, with the
   * input the history carries — before the sub-run gets to verify the answer,
   * so everything the body does ahead of its first `runAgent` happens on the
   * client's say-so. Which is why the record has to carry the server's
   * signature over the sub-run it parked, the calls it left open and the
   * input the tool was given, and why a record without one, or with one that
   * does not match what it now says, is not a parked run at all.
   *
   * The failure says which of those it was. "Expired" is an ordinary outcome
   * in threaded mode — a question answered a day late — and telling that
   * user the run never parked would send them looking for a bug that is not
   * there; a record that fails its MAC is the other thing entirely, and the
   * two are kept apart for the same reason `resolveAnswer` keeps them apart.
   *
   * `below` is the answer's path with this run's prefix already removed, so
   * `below[0]` is `call` itself and `below[1]`, when there is one, names the
   * call to re-enter one level further down.
   */
  private parkedBelow(
    call: ToolCallPart,
    below: string[],
    toolCallId: string,
  ): { ok: true; signature: string } | { ok: false; reason: "unparked" | "unsigned" | "expired" } {
    const wanted = below.length > 1 ? below[1] : toolCallId;
    const path = [...this.pathPrefix, call.toolCallId];
    const parked = (call.nested ?? []).find(
      (run) => run.finishReason === "awaiting-input" && openCallIds(run.messages).has(wanted),
    );
    if (!parked) return { ok: false, reason: "unparked" };
    if (typeof parked.signature !== "string") return { ok: false, reason: "unsigned" };
    const verified = verifyNestedRun(parked.signature, {
      path,
      nestedRunId: parked.runId,
      open: [...openCallIds(parked.messages)],
      input: call.input,
      subject: this.params.subject ?? null,
    });
    if (verified.ok === false) {
      return { ok: false, reason: verified.reason === "expired" ? "expired" : "unsigned" };
    }
    return { ok: true, signature: parked.signature };
  }

  /**
   * Re-enters a tool whose sub-agent asked the user something.
   *
   * From the top, with `ctx.resumed === true` — there is no other way. A JS
   * async generator cannot be suspended across a turn boundary, so the body
   * runs again and `runAgent` replays its finished sub-runs out of
   * `ToolCallPart.nested` instead of re-running them. Which means the code
   * *before* the escalating `runAgent` runs twice; that bargain is documented on
   * `ToolContext.runAgent` and it is the price of not needing a checkpoint API.
   */
  private async reenter(
    entry: { message: AgentMessage; call: ToolCallPart },
    answers: ClientToolResult[],
    escalated: PendingToolCall[],
  ): Promise<ToolResultPart | null> {
    const name = String(entry.call.name);
    const resolved = this.config.registry.get(name);
    if (!resolved || !resolved.tool.execute) {
      return {
        type: "tool-result",
        toolCallId: entry.call.toolCallId,
        name: entry.call.name,
        status: "error",
        error: {
          code: "invalid_tool_result",
          message: `The tool "${name}" no longer exists, so the sub-agent's question cannot be delivered.`,
          toolCallId: entry.call.toolCallId,
          retryable: false,
        },
      };
    }

    // Checked the way `runTools` checked the model's arguments. The record's
    // signature has already said this is the input the tool parked on, so what
    // this catches is the tool itself having moved: a schema that changed
    // between the turn that parked and the turn that answers. The tool's typed
    // input is a contract with the tool as it is now, and a value the schema
    // rejects must not reach it — the failure is a result the model can read,
    // exactly like a mis-typed argument on the way in.
    const parsed = resolved.inputSchema!.safeParse(entry.call.input);
    if (parsed.ok === false) {
      return {
        type: "tool-result",
        toolCallId: entry.call.toolCallId,
        name: entry.call.name,
        status: "error",
        error: {
          code: "invalid_tool_input",
          message: `Invalid arguments for "${name}": ${parsed.errors.join(", ")}`,
          toolCallId: entry.call.toolCallId,
          retryable: true,
        },
      };
    }

    const call = this.amendCall(entry);
    // The parsed value is the only input the call has from here on, as in
    // `runTools` — the clone carries what the tool was actually given.
    call.input = parsed.value;
    try {
      // Step 0, like an approval executed on the way in: this belongs to the
      // turn, not to a step of the loop that has not started yet.
      return await raceAbort(
        this.executeTool(resolved, entry.message.id, call, parsed.value, 0, { answers }),
        this.controller.signal,
      );
    } catch (error) {
      if (error instanceof PendingEscalation) {
        // Asked again. No result attaches, so the call stays open and the next
        // turn re-enters it exactly as this one did.
        escalated.push(...error.pending);
        return null;
      }
      throw error;
    }
  }

  /**
   * Clones the tool-call part before a replay writes to its `nested`.
   *
   * The message holding it came from an earlier run and belongs to the caller's
   * `messages` array; the run must not reach back into its own input and change
   * it under a controller that has already persisted it. Cloning the part into
   * the amended copy is also what makes the updated sub-run transcript
   * something `onMessage` can report — see `reportDeferred`, which is why the
   * message is marked unreported here even though no result may ever attach.
   */
  private amendCall(entry: { message: AgentMessage; call: ToolCallPart }): ToolCallPart {
    const message = this.amend(entry.message);
    const at = message.content.indexOf(entry.call);
    const call: ToolCallPart = {
      ...entry.call,
      nested: (entry.call.nested ?? []).map((run) => ({ ...run })),
      // Cloned for the same reason `nested` is: the replayed body's memo writes
      // into this array, and the array on the original part belongs to the
      // caller's `messages`, which is an input and not scratch space.
      ...(entry.call.attachments
        ? { attachments: entry.call.attachments.map((record) => ({ ...record })) }
        : {}),
    };
    if (at >= 0) message.content[at] = call;
    this.unreported.add(message);
    return call;
  }

  /** Tool calls in the history with no result anywhere after them. */
  private openCalls(): { message: AgentMessage; call: ToolCallPart }[] {
    const resolvedIds = new Set<string>();
    for (const message of this.history) {
      for (const part of message.content) {
        if (part.type === "tool-result") resolvedIds.add(part.toolCallId);
      }
    }
    const open: { message: AgentMessage; call: ToolCallPart }[] = [];
    for (const message of this.history) {
      for (const part of message.content) {
        if (part.type === "tool-call" && !resolvedIds.has(part.toolCallId)) {
          open.push({ message, call: part });
        }
      }
    }
    return open;
  }

  /**
   * Verifies one answer and turns it into a result part, or reports why not.
   *
   * `null` means the call stays unanswered and falls through to the implicit
   * denial above — which is the right outcome for a bad signature: the model
   * must not see a result the server cannot vouch for. `"open"` means the
   * opposite: the answer was good, the tool ran, and it is now waiting on a
   * question of its own, so the call must stay open *without* being denied.
   */
  /**
   * Spends a token's nonce in the run's `NonceStore`. A store that throws (its
   * Redis is down, say) is logged and counted as spent: the answer is refused
   * and the user asked again, rather than acted on unchecked.
   */
  private async spend(
    spendIn: (signature: string, store: NonceStore) => Promise<boolean>,
    signature: string,
  ): Promise<boolean> {
    try {
      return await spendIn(signature, this.params.nonces ?? defaultNonceStore);
    } catch (error) {
      this.writeLog(`[gemi/ai] agent "${this.config.name}" could not spend a nonce`, { error });
      return false;
    }
  }

  /**
   * Records an approved tool's result on its receipt once it is known (#458),
   * and only then hands it on, so a presentation that arrives after this run
   * answered finds it. Chained to the execution rather than to the run's race,
   * so a tool that finishes after a `stop()` still records what it did.
   *
   * A tool that never produces a result — it rejected, or escalated a question
   * of its own — leaves the claim held: whether it acted is unknown, and a
   * later presentation is `blocked` rather than run again.
   */
  private async recordReceipt(
    receipt: { store: ReceiptStore; id: string; expiresAt: number },
    execution: Promise<ToolResultPart>,
  ): Promise<ToolResultPart> {
    const result = await execution;
    try {
      await receipt.store.complete(receipt.id, result, receipt.expiresAt);
    } catch (error) {
      this.writeLog(`[gemi/ai] agent "${this.config.name}" could not record a tool receipt`, {
        error,
      });
    }
    return result;
  }

  private async resolveAnswer(
    entry: { message: AgentMessage; call: ToolCallPart },
    answer: ClientToolResult,
    escalated: PendingToolCall[],
  ): Promise<ToolResultPart | "open" | null> {
    const call = entry.call;
    const name = String(call.name);
    const resolved = this.config.registry.get(name);
    const reject = (message: string) => {
      this.emit({
        type: "error",
        error: {
          code: "invalid_tool_result",
          message,
          toolCallId: call.toolCallId,
          retryable: false,
        },
      });
      return null;
    };

    if (!resolved) {
      return reject(`The tool "${name}" no longer exists, so its answer cannot be checked.`);
    }
    const kind = pendingKind(resolved.tool);
    if (!kind) {
      return reject(`"${name}" is a server tool with no pending question.`);
    }
    if (typeof answer.signature !== "string" || answer.signature.length === 0) {
      return reject(`The answer for "${name}" carried no signature.`);
    }

    // The issuing run, read out of the token. The turn answering a pending call
    // is a *new* run with a new id, so the id the signature was made under has
    // to travel with the signature — and it is covered by the MAC, so a client
    // that edits it fails below rather than being believed.
    const issued = readSignature(answer.signature);
    if (!issued) {
      return reject(`The signature for "${name}" is malformed.`);
    }

    // The path is this run's own, not the one the client sent. The client's
    // copy was used to route the answer here and nothing else; recomputing the
    // MAC over what the server issued is what makes a moved answer fail instead
    // of being believed.
    const verified = verifyPendingCall(answer.signature, {
      ...this.claimsFor(call.toolCallId, name, kind, call.input),
      runId: issued.runId,
    });

    if (verified.ok === false) {
      return reject(
        verified.reason === "expired"
          ? `The approval for "${name}" has expired. Ask again.`
          : `The answer for "${name}" does not match the call the server made.`,
      );
    }

    // An approval that already ran is answered with what it did, before the
    // nonce is looked at (#458): its nonce was spent by the run that executed
    // it, so the check below would refuse it, and a retried submit whose
    // response was lost would tell the user the approval was not used when the
    // tool has already acted on it. Claimed before spending, so that two
    // instances whose nonce stores are not shared still run it once.
    let receipt: { store: ReceiptStore; id: string; expiresAt: number } | undefined;
    if (
      this.params.receipts &&
      kind === "approval" &&
      "approve" in answer &&
      answer.approve === true
    ) {
      const store = this.params.receipts;
      const id = executionReceiptId(this.config.name, {
        ...this.claimsFor(call.toolCallId, name, kind, call.input),
        runId: issued.runId,
      });
      let claim: ReceiptClaim;
      try {
        claim = await store.claim(id, issued.expiresAt);
      } catch (error) {
        // As with a nonce store that throws: refused, not run unchecked.
        this.writeLog(`[gemi/ai] agent "${this.config.name}" could not claim a tool receipt`, {
          error,
        });
        return reject(`The approval for "${name}" could not be checked. Ask again.`);
      }
      if (claim.status === "replay") {
        return { ...claim.result, toolCallId: call.toolCallId, name: call.name } as ToolResultPart;
      }
      if (claim.status === "blocked") {
        return {
          type: "tool-result",
          toolCallId: call.toolCallId,
          name: call.name,
          status: "error",
          error: {
            code: "tool_error",
            message: `"${name}" was already approved and started, and its result is not recorded yet: it is still running, or it stopped before finishing. It was not run again.`,
            toolCallId: call.toolCallId,
            retryable: false,
          },
        };
      }
      receipt = { store, id, expiresAt: issued.expiresAt };
    }

    // Verifying says the server once asked this exact question; spending the
    // nonce says nobody has answered it yet. Without this step a captured token
    // approves the same call every time it is presented — the client rewinds to
    // the history from before the result existed and replays, and the human who
    // approved once has approved forever.
    if (!(await this.spend(spendPendingCall, answer.signature))) {
      // Claimed for nothing: nothing ran, so a later presentation must not be
      // told it is running. Answered by a run that predates the store, or
      // denied before: either way there is no result to replay.
      await receipt?.store.release(receipt.id).catch((error) => {
        this.writeLog(`[gemi/ai] agent "${this.config.name}" could not release a tool receipt`, {
          error,
        });
      });
      return reject(`The answer for "${name}" has already been used. Ask again.`);
    }

    if ("approve" in answer) {
      if (kind !== "approval") {
        return reject(`"${name}" is answered by the client, not approved.`);
      }
      if (answer.approve === true) {
        // Raced against the abort signal exactly as `runTools` does. A tool
        // that does not honour `ctx.signal` must not be able to hold the run
        // open, and this is the one execution outside the loop — a `stop()`
        // landing here used to hang the run forever, which is precisely the
        // dangling state `stop()` exists to prevent.
        //
        // Step 0: the approval landed before this run took its first model
        // step, so it belongs to no step of this loop. `call.input` is the
        // value the signature covers — see `runTools`.
        //
        // Cloned first, for the same reason `reenter` clones: an approved tool
        // may nest, and `nestedRunner` writes `nested` onto the part it is
        // given. That part belongs to the caller's `messages` array, which is
        // an input and not scratch space — and the clone is what makes the
        // sub-run transcript something `onMessage` can report.
        const executing = this.amendCall(entry);
        const execution = this.executeTool(
          resolved,
          entry.message.id,
          executing,
          executing.input,
          0,
        );
        try {
          return await raceAbort(
            receipt ? this.recordReceipt(receipt, execution) : execution,
            this.controller.signal,
          );
        } catch (error) {
          if (error instanceof PendingEscalation) {
            // An approval whose tool asked the user something of its own. The
            // step loop and `reenter` both collect this; without the same catch
            // here the rejection left `ingestTurn` and was normalized into a
            // `provider_error`, which ended the run with the sub-agent's
            // question thrown away and the approval's nonce already spent.
            escalated.push(...error.pending);
            return "open";
          }
          throw error;
        }
      }
      return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        name: call.name,
        status: "denied",
        cause: "refused",
        reason: answer.reason,
      };
    }

    if ("output" in answer) {
      if (kind === "approval") {
        // An approval is a tool the *server* runs. A client handing back its
        // output would be fabricating a result, not approving one.
        return reject(`"${name}" is approved, not answered: the server produces its result.`);
      }
      const schema = resolved.tool.outputSchema;
      const parsed = schema
        ? schema.safeParse(answer.output)
        : { ok: true as const, value: answer.output };
      if (parsed.ok === false) {
        return {
          type: "tool-result",
          toolCallId: call.toolCallId,
          name: call.name,
          status: "error",
          error: {
            code: "invalid_tool_result",
            message: `The answer for "${name}" did not match its output schema: ${parsed.errors.join(", ")}`,
            toolCallId: call.toolCallId,
            retryable: true,
          },
        };
      }
      return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        name: call.name,
        status: "ok",
        output: parsed.value,
      };
    }

    return reject(`The answer for "${name}" carried neither an approval nor an output.`);
  }

  /**
   * Puts the result next to the call that asked for it.
   *
   * The message being amended came from an earlier run, so it is cloned before
   * it is touched — the caller's `messages` array is an input, not scratch
   * space, and a controller that persisted it would otherwise see it change
   * under it. The clone is reported through `onMessage` and returned in
   * `result()`, which is why a store keyed by message id has to upsert.
   */
  private attachToHistory(
    entry: { message: AgentMessage; call: ToolCallPart },
    result: ToolResultPart,
  ) {
    const message = this.amend(entry.message);
    message.content.push(result);
    this.unreported.add(message);
    this.emit({ type: "tool-result", messageId: message.id, part: result });
  }

  /**
   * The provider refused a stored file and the call went ahead without it
   * (#684). Every part holding that id is marked `providerRejected`, so the
   * next request sends a note in its place rather than an id that fails the
   * request again — the history is sent whole on every turn, and without the
   * mark one dead file costs every later turn a refused request.
   *
   * Persisted the way a late tool result is: a message from an earlier run is
   * amended (cloned, then reported and returned in `result()`), and one this
   * run made is changed in place and reported again. Either way the store
   * sees the same id with new content, which its contract says to upsert.
   * The part is replaced rather than written to, because the original object
   * may still be the caller's.
   *
   * Logged as a warning, not an error: the run goes on, and the model is told
   * the file could not be read, so the user hears about it in the answer. The
   * log is for whoever has to work out why a file stopped being readable.
   */
  private markFileRejected(
    fileId: string,
    reason: string,
    detail: { status?: number; requestId?: string },
  ): void {
    for (const original of this.history) {
      const hit = original.content.some(
        (part) => part.type === "file" && part.fileId === fileId && !part.providerRejected,
      );
      if (!hit) continue;
      const message = this.produced.includes(original) ? original : this.amend(original);
      message.content = message.content.map((part) =>
        part.type === "file" && part.fileId === fileId && !part.providerRejected
          ? { ...part, providerRejected: true as const }
          : part,
      );
      // The message being built by this step is reported when it is finalized;
      // queueing it here as well would report it before it is finished.
      if (message !== this.current) this.unreported.add(message);
    }
    if (!this.config.logErrors) return;
    const message = `[gemi/ai] agent "${this.config.name}": the provider refused file ${fileId}${
      detail.status !== undefined ? ` (${detail.status})` : ""
    }; it was left out of the request and will not be sent again: ${reason}`;
    const metadata = {
      agent: this.config.name,
      runId: this.runId,
      ...(this.params.threadId ? { threadId: this.params.threadId } : {}),
      fileId,
      ...detail,
    };
    let logged = false;
    try {
      Log.warning(message, metadata);
      logged = true;
    } catch {
      // No application to resolve a logger from.
    }
    if (!logged || process.env.NODE_ENV === "development") console.warn(message, metadata);
  }

  /** The clone of an earlier run's message that this run may write to. One per
   *  message id, so two results for the same message do not fork it. */
  private amend(original: AgentMessage): AgentMessage {
    const existing = this.amended.get(original.id);
    if (existing) return existing;
    const message: AgentMessage = { ...original, content: [...original.content] };
    const index = this.history.indexOf(original);
    if (index >= 0) this.history[index] = message;
    this.produced.push(message);
    this.amended.set(original.id, message);
    return message;
  }

  /**
   * Persists the messages this run finished outside `finalizeMessage`, once each
   * and in the order it finished them.
   *
   * Called from the end of `ingestTurn`, from the abort path, and from
   * `finalizeMessage`. From the abort path because a stop that lands while an
   * approved tool is running has to persist the results that *did* attach this
   * turn — otherwise the work is done, the transcript on the stream shows it,
   * and the store never hears about it. From `finalizeMessage` because an
   * injected message has to reach `onMessage` after the assistant message it
   * sits below, and a `Set` preserves insertion order, which here is transcript
   * order.
   */
  private async reportDeferred(): Promise<void> {
    const pending = [...this.unreported];
    this.unreported.clear();
    for (const message of pending) await this.report(message);
  }

  // --- stopping ----------------------------------------------------------

  /**
   * The run's last act: leave a transcript the next turn can be built on.
   *
   * Everything the model asked for and did not get becomes a `denied` result
   * with `cause: "stopped"`, and the interrupted message is finalized as
   * `aborted` keeping whatever text it had produced. Both go out on the stream
   * and through `onMessage`. A cancel that merely stopped emitting would leave
   * a dangling tool call, and the provider would reject the history on the very
   * next message the user sent.
   */
  private async finalizeAborted(): Promise<void> {
    // Sub-runs first. They share this run's signal so they are already closing;
    // what is being waited for is the moment each writes its transcript onto
    // its tool call, because everything below this line persists messages.
    if (this.nestedSettling.size > 0) {
      await Promise.all([...this.nestedSettling]);
    }
    // Calls left open anywhere in the history, not just on the message this run
    // was building. A stop that lands while an approval this turn is executing
    // has no current message at all — the call belongs to an *earlier* turn's
    // message — and denying only `this.current` would leave that one dangling
    // in the very transcript this method exists to keep valid.
    for (const entry of this.openCalls()) {
      if (entry.message === this.current) continue;
      this.attachToHistory(entry, {
        type: "tool-result",
        toolCallId: entry.call.toolCallId,
        name: entry.call.name,
        status: "denied",
        cause: "stopped",
        reason: this.stopReason,
      });
    }
    // Results that did attach this turn have not been persisted yet: the report
    // pass at the end of `ingestTurn` is one of the things the abort skipped.
    await this.reportDeferred();

    const message = this.current;
    if (message) {
      const answered = new Set(
        message.content
          .filter((part): part is ToolResultPart => part.type === "tool-result")
          .map((part) => part.toolCallId),
      );
      for (const part of [...message.content]) {
        if (part.type !== "tool-call" || answered.has(part.toolCallId)) continue;
        // A call whose arguments were still arriving is finalized too: the
        // client has already been shown it, and an unresolved part is exactly
        // what this method exists to prevent.
        delete part.partial;
        this.addResult(message, {
          type: "tool-result",
          toolCallId: part.toolCallId,
          name: part.name,
          status: "denied",
          cause: "stopped",
          reason: this.stopReason,
        });
      }
    }
    if (this.timedOutAfter !== undefined) {
      // An error, not an outcome: nobody asked for this run to end, and an app
      // has to be able to see that it did — in the log, on `result().error`,
      // and as a rejection under `throwOnError`. Recorded before the message
      // closes, as every other failure is.
      this.fail({
        code: "timeout",
        message: `The run did not finish within its time limit of ${formatDuration(this.timedOutAfter)} (maxRunDurationMs: ${this.timedOutAfter}) and was stopped.`,
        retryable: true,
      });
      this.finishReason = "error";
      await this.finalizeMessage("error");
      return;
    }
    this.finishReason = "aborted";
    await this.finalizeMessage("aborted");
  }
}

function pendingKind(tool: AnyAgentTool): "approval" | "question" | "client" | null {
  if (tool.answeredBy === "client") {
    // A question is a client tool whose input is the prompt itself. The
    // distinction is for the UI — one renders a dialog, the other runs code —
    // and it costs nothing to carry.
    return tool.inputSchema === questionSchema ? "question" : "client";
  }
  return tool.requiresApproval ? "approval" : null;
}

function parseArgs(args: string): any {
  if (!args || !args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
