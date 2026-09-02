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
};

/**
 * Three ways a tool's result comes to exist, and the one thing they share is
 * that none of them changes the conversation's shape.
 *
 * `execute` — the server runs it.
 * `deferred` — the agent declares it, the controller supplies the
 *   implementation at request time; for the tool that has to close over the
 *   request in a way `ctx` does not cover, or that differs per deployment.
 * `answeredBy: "client"` — the browser produces the result: a question for the
 *   user, or something only the page can do. The stream ends `awaiting-input`
 *   and the answer arrives as an ordinary turn.
 *
 * `requiresApproval` is orthogonal and applies to the first two: the server can
 * run the tool, but asks first. That, too, ends the stream `awaiting-input`,
 * which is the whole reason there is no second endpoint — an approval is a
 * question whose answer happens to be yes or no.
 */
export type ToolDefinition<Name extends string, Input, Output> =
  | (ToolDefinitionBase<Name, Input, Output> & {
      deferred?: false;
      answeredBy?: "server";
      execute: ToolExecute<Input, Output>;
      requiresApproval?: boolean;
    })
  | (ToolDefinitionBase<Name, Input, Output> & {
      deferred: true;
      answeredBy?: "server";
      execute?: never;
      requiresApproval?: boolean;
    })
  | (ToolDefinitionBase<Name, Input, Output> & {
      answeredBy: "client";
      outputSchema: Schema<Output>;
      deferred?: never;
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

/** The tool tuple, erased to the payload types the client is allowed to see. */
export type ToolShapesOf<T extends readonly AnyAgentTool[]> = {
  [K in T[number] as K["name"]]: K extends AgentTool<any, infer I, infer O>
    ? { input: I; output: O }
    : never;
};

// --- skills --------------------------------------------------------------

/**
 * A skill is instructions the model can go and fetch.
 *
 * Inlining every skill into the system prompt costs its tokens on every request
 * and gets worse with each skill added, so only `name` and `description` are
 * prompted; a reserved `load_skill` tool hands over `instructions` (and any
 * files) when the model decides it needs them. The cost of a skill the model
 * does not use is then a line of text, which is what makes having thirty of
 * them viable.
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
  T extends readonly AnyAgentTool[],
  S extends readonly Skill[],
  O extends Schema<any> | undefined,
> {
  name: string;
  /** The system prompt. Per-request additions belong on the controller, which
   *  has the request; this is the part that is the same for everyone. */
  instructions?: string;
  provider: AgentProvider;
  tools?: T;
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
  /** Implementations for `deferred` tools, supplied by the controller. */
  tools?: Record<string, ToolExecute<any, any>>;
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
  stop(): void;
}

export declare class Agent<
  const T extends readonly AnyAgentTool[] = readonly AnyAgentTool[],
  const S extends readonly Skill[] = readonly Skill[],
  O extends Schema<any> | undefined = undefined,
> {
  readonly name: string;
  readonly tools: T;
  readonly skills: S;
  readonly provider: AgentProvider;
  readonly output: O;

  static create<
    const T extends readonly AnyAgentTool[],
    const S extends readonly Skill[],
    O extends Schema<any> | undefined = undefined,
  >(params: CreateAgentParams<T, S, O>): Agent<T, S, O>;

  stream(params: AgentStreamParams): AgentRun<ToolShapesOf<T>, OutputOf<O>>;
}

export type OutputOf<O> = O extends Schema<any> ? Infer<O> : never;

export type AnyAgent = Agent<any, any, any>;
