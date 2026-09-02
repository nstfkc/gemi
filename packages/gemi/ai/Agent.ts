// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { HttpRequest } from "../http";
import type { AgentProvider } from "./AgentProvider";
import type { Infer, Schema } from "./Schema";
import type {
  AgentMessage,
  AgentStreamEvent,
  AgentStreamFrame,
  ClientTurn,
  FinishReason,
  ToolShapes,
  Usage,
} from "./types";

// --- tools ---------------------------------------------------------------

/**
 * Everything a tool needs from the request it is running inside.
 *
 * Tools are created once at module scope and shared by every request, so they
 * cannot close over a user or an abort signal — and anything mutable stored on
 * the tool itself would leak across requests. That is why the run's state
 * arrives as an argument instead: the tool stays a singleton and the context is
 * per call.
 */
export interface ToolContext {
  req: HttpRequest<any, any>;
  runId: string;
  threadId?: string;
  toolCallId: string;
  /**
   * Aborted when the user calls `stop()`. Not when the connection drops — a run
   * outlives the request that started it so a refresh can reattach, which means
   * a disconnect is no longer a signal to stop working.
   */
  signal: AbortSignal;
  /** Which step of the tool loop this is, starting at 1. */
  step: number;
}

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
  inputSchema: Schema<Input>;
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
export type ToolDefinition<Name extends string, Input, Output> =
  | (ToolDefinitionBase<Name, Input, Output> & {
      answeredBy?: "server";
      execute: ToolExecute<Input, Output>;
      requiresApproval?: boolean;
    })
  | (ToolDefinitionBase<Name, Input, Output> & {
      answeredBy: "client";
      outputSchema: Schema<Output>;
      execute?: never;
      /** Meaningless here: the client answering *is* the approval. */
      requiresApproval?: never;
    });

export declare class AgentTool<Name extends string = string, Input = unknown, Output = unknown> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema?: Schema<Output>;
  readonly requiresApproval: boolean;
  readonly deferred: boolean;
  readonly answeredBy: "server" | "client";
  readonly namespace?: string;
  readonly execute?: ToolExecute<Input, Output>;

  /**
   * `const` on the params is what preserves `name` as a literal, which is what
   * lets the browser discriminate a tool part by name.
   */
  static create<const Name extends string, Input, Output>(
    params: ToolDefinition<Name, Input, Output>,
  ): AgentTool<Name, Input, Output>;

  /**
   * Sugar for the common client tool: the agent asks the user something and
   * waits. Equivalent to `answeredBy: "client"` with an input schema of one
   * prompt field.
   */
  static ask<const Name extends string, Output>(params: {
    name: Name;
    description: string;
    outputSchema: Schema<Output>;
  }): AgentTool<Name, { question: string }, Output>;
}

export type AnyAgentTool = AgentTool<string, any, any>;

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
export declare class ToolNamespace<
  Name extends string = string,
  T extends readonly AnyAgentTool[] = readonly AnyAgentTool[],
> {
  readonly name: Name;
  readonly description: string;
  readonly tools: T;
  static create<const Name extends string, const T extends readonly AnyAgentTool[]>(params: {
    name: Name;
    /** What the model reads when deciding whether to search inside. */
    description: string;
    tools: T;
    /** Defers every tool in the group, so the whole namespace costs its own
     *  description plus one line per tool until something is loaded. */
    deferred?: boolean;
  }): ToolNamespace<Name, T>;
}

/** What an agent's `tools` may hold: tools, or namespaces of them. */
export type ToolEntry = AnyAgentTool | ToolNamespace<string, readonly AnyAgentTool[]>;

type FlattenTools<T extends readonly ToolEntry[]> = T[number] extends infer E
  ? E extends ToolNamespace<any, infer NT>
    ? NT[number]
    : E
  : never;

/** The tool tuple, erased to the payload types the client is allowed to see. */
export type ToolShapesOf<T extends readonly ToolEntry[]> = {
  [K in FlattenTools<T> as K["name"]]: K extends AgentTool<any, infer I, infer O>
    ? { input: I; output: O }
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

export declare class Skill<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  static create<const Name extends string>(params: SkillDefinition<Name>): Skill<Name>;
}

// --- agent ---------------------------------------------------------------

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

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
  reasoning?: ReasoningEffort;
}

/**
 * One call per client turn — a first message and an answer to a pending
 * approval take the same path, because they are the same thing: the next turn
 * of a conversation.
 */
export interface AgentStreamParams {
  /** Prior turns. The controller loads these from its store, or takes what the
   *  client sent when running stateless. */
  messages: AgentMessage[];
  /** The client's turn: text, answers to pending calls, or both. */
  turn?: ClientTurn;
  req: HttpRequest<any, any>;
  /** Aborted by an explicit `stop`, not by a disconnect. */
  signal?: AbortSignal;
  runId?: string;
  threadId?: string;
  /** Appended to the agent's own `instructions` for this request only. */
  instructions?: string;
  /** Per-request model choice, e.g. letting a user pick. */
  provider?: AgentProvider;
  maxSteps?: number;
  reasoning?: ReasoningEffort;
}

export type AgentRunResult<T extends ToolShapes, O> = {
  runId: string;
  /** Everything produced this run — the controller persists these. */
  messages: AgentMessage<T, O>[];
  finishReason: FinishReason;
  usage: Usage;
  /** Set when the agent declares an `output` schema and the run finished. */
  output?: O;
};

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
  result(): Promise<AgentRunResult<T, O>>;
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

export declare class Agent<
  const T extends readonly ToolEntry[] = readonly ToolEntry[],
  const S extends readonly Skill[] = readonly Skill[],
  O extends Schema<any> | undefined = undefined,
> {
  readonly name: string;
  readonly tools: T;
  readonly skills: S;
  readonly provider: AgentProvider;
  readonly output: O;

  static create<
    const T extends readonly ToolEntry[],
    const S extends readonly Skill[],
    O extends Schema<any> | undefined = undefined,
  >(params: CreateAgentParams<T, S, O>): Agent<T, S, O>;

  stream(params: AgentStreamParams): AgentRun<ToolShapesOf<T>, OutputOf<O>>;
}

export type OutputOf<O> = O extends Schema<any> ? Infer<O> : never;

export type AnyAgent = Agent<any, any, any>;
