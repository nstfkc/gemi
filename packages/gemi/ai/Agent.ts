import type { HttpRequest } from "../http";
import type {
  AgentProvider,
  ProviderToolNamespace,
  ProviderToolSpec,
} from "./AgentProvider";
import type { Infer, Schema } from "./Schema";
import {
  consumePendingCall,
  readSignature,
  signPendingCall,
  verifyPendingCall,
} from "./signing";
import type {
  AgentError,
  AgentMessage,
  AgentStreamEvent,
  AgentStreamFrame,
  ClientToolResult,
  ClientTurn,
  FinishReason,
  NestedRun,
  PendingToolCall,
  ToolCallPart,
  ToolResultPart,
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
  runAgent<A extends AnyAgent>(
    agent: A,
    params?: RunAgentParams,
  ): Promise<NestedRunResult>;
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
    super(
      `A nested agent run is waiting on the user for ${params.pending.length} tool call(s).`,
    );
    this.name = "PendingEscalation";
    this.pending = params.pending;
    this.path = params.path;
    this.nested = params.nested;
  }
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
  readonly inputSchema: Schema<Input>;
  readonly outputSchema?: Schema<Output>;
  readonly requiresApproval: boolean;
  readonly deferred: boolean;
  readonly answeredBy: "server" | "client";
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
  }

  /**
   * `const` on the params is what preserves `name` as a literal, which is what
   * lets the browser discriminate a tool part by name.
   */
  static create<const Name extends string, Input, Output, Progress = never>(
    params: ToolDefinition<Name, Input, Output, Progress>,
  ): AgentTool<Name, Input, Output, Progress> {
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
    if (typeof value !== "object" || value === null || typeof (value as any).question !== "string") {
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

  private constructor(params: {
    name: Name;
    description: string;
    tools: T;
    deferred?: boolean;
  }) {
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
export type ToolShapesOf<T extends readonly ToolEntry[]> = {
  [K in Extract<FlattenTools<T>, AnyAgentTool> as K["name"]]: K extends AgentTool<
    any,
    infer I,
    infer O,
    infer P
  >
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

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  required: [] as string[],
  additionalProperties: false as const,
};

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
  /**
   * How far `ctx.runAgent` may nest below this agent. Default 3.
   *
   * It is a limit on the *tree*, taken from the run at the root, so raising it
   * on a sub-agent cannot deepen a run it did not start. A cycle is caught by
   * the agent-name chain before this is reached — this is for the mutually
   * recursive shape a name check cannot see, and for the merely runaway one.
   */
  maxDepth?: number;
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

/** A tool plus where it sits in the prompt. Fixed for the life of the agent. */
type ResolvedTool = {
  tool: AnyAgentTool;
  namespace?: string;
  deferred: boolean;
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
    };
  }

  static create<
    const T extends readonly ToolEntry[],
    const S extends readonly Skill[],
    O extends Schema<any> | undefined = undefined,
  >(params: CreateAgentParams<T, S, O>): Agent<T, S, O> {
    return new Agent(params);
  }

  stream(params: AgentStreamParams): AgentRun<ToolShapesOf<T>, OutputOf<O>> {
    const config: RunConfig = {
      ...this.config,
      provider: params.provider ?? this.config.provider,
      maxSteps: params.maxSteps ?? this.config.maxSteps,
      reasoning: params.reasoning ?? this.config.reasoning,
    };
    return new AgentRunImpl(config, params) as unknown as AgentRun<
      ToolShapesOf<T>,
      OutputOf<O>
    >;
  }
}

export type OutputOf<O> = O extends Schema<any> ? Infer<O> : never;

export type AnyAgent = Agent<any, any, any>;

// --- lowering ------------------------------------------------------------

function toolSpec(resolved: ResolvedTool): ProviderToolSpec {
  return {
    name: resolved.tool.name,
    description: resolved.tool.description,
    parameters: resolved.tool.inputSchema.toJSONSchema(),
    strict: true,
    deferred: resolved.deferred,
  };
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
): { registry: Map<string, ResolvedTool>; providerTools: (ProviderToolSpec | ProviderToolNamespace)[] } {
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
        const resolved = { tool, namespace: entry.name, deferred: entry.deferred || tool.deferred };
        register(resolved);
        members.push(toolSpec(resolved));
      }
      providerTools.push({ name: entry.name, description: entry.description, tools: members });
      continue;
    }
    const resolved = { tool: entry, deferred: entry.deferred };
    register(resolved);
    providerTools.push(toolSpec(resolved));
  }

  if (skills.length > 0) {
    const members: ProviderToolSpec[] = [];
    for (const skill of skills) {
      const tool = skillTool(skill);
      register({ tool, namespace: SKILLS_NAMESPACE, deferred: false });
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
        typeof skill.instructions === "function"
          ? await skill.instructions()
          : skill.instructions;
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

class RunAborted extends Error {
  constructor() {
    super("The run was stopped");
    this.name = "RunAborted";
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new RunAborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RunAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(total: Usage, next: Usage | undefined): Usage {
  if (!next) return total;
  const merged: Usage = {
    inputTokens: total.inputTokens + (next.inputTokens ?? 0),
    outputTokens: total.outputTokens + (next.outputTokens ?? 0),
    totalTokens: total.totalTokens + (next.totalTokens ?? 0),
  };
  if (next.reasoningTokens !== undefined || total.reasoningTokens !== undefined) {
    merged.reasoningTokens = (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  }
  if (next.cachedInputTokens !== undefined || total.cachedInputTokens !== undefined) {
    merged.cachedInputTokens = (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0);
  }
  return merged;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncGenerator).next === "function" &&
    Symbol.asyncIterator in (value as object)
  );
}

/**
 * The best parse of a JSON document that is still arriving.
 *
 * Exists so a UI can bind fields before the object closes. It closes whatever
 * brackets are open and drops a trailing key with no value; when even that does
 * not parse it gives up and returns an empty object rather than throwing,
 * because a snapshot is a convenience and a run must not die for one.
 */
function bestEffortParse(text: string): any {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // fall through to repair
  }
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") closers.push("}");
    else if (char === "[") closers.push("]");
    else if (char === "}" || char === "]") closers.pop();
  }
  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/[,:]\s*$/, "");
  const suffix = closers.reverse().join("");
  try {
    return JSON.parse(repaired + suffix);
  } catch {
    // A trailing `"key":` leaves a property with no value; drop the key too.
    try {
      return JSON.parse(repaired.replace(/,?\s*"[^"]*"\s*$/, "") + suffix);
    } catch {
      return {};
    }
  }
}

type StepOutcome = {
  reason: FinishReason;
  error?: AgentError;
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

class AgentRunImpl implements AgentRun<ToolShapes, unknown> {
  readonly runId: string;

  private readonly config: RunConfig;
  private readonly params: AgentStreamParams;
  private readonly controller = new AbortController();

  private readonly buffer: AgentStreamFrame<ToolShapes, unknown>[] = [];
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  private ended = false;

  /** The working history handed to the provider, and what this run produced. */
  private history: AgentMessage[] = [];
  private produced: AgentMessage[] = [];
  private current: AgentMessage | null = null;

  /** Messages from an earlier run this one has amended, by id. Cloned once and
   *  reused, so two results for the same message do not fork it. */
  private readonly amended = new Map<string, AgentMessage>();
  /** Amended messages that have not yet gone through `onMessage`. */
  private readonly unreported = new Set<AgentMessage>();

  private usage: Usage = emptyUsage();
  private finishReason: FinishReason = "stop";
  private output: unknown;
  private stopReason: string | undefined;

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

  constructor(config: RunConfig, params: AgentStreamParams) {
    this.config = config;
    this.params = params;
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

    // Started here, not on first read. A run outlives the request that began
    // it, so nothing may depend on someone being attached — a client that
    // never reads still gets its tools run and its messages persisted.
    this.settled = this.execute();
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

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for await (const frame of frames) {
            if (cancelled) break;
            // `id:` carries the cursor so a browser reconnecting with
            // `Last-Event-ID` is already asking the right question.
            controller.enqueue(
              encoder.encode(`id: ${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`),
            );
          }
        } catch {
          // A stream that cannot be written to is a dead reader, not a dead
          // run. Nothing to report and nothing to stop.
        }
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

  result(): Promise<AgentRunResult<ToolShapes, unknown>> {
    return this.settled;
  }

  stop(params?: { reason?: string }): void {
    if (this.ended || this.controller.signal.aborted) return;
    this.stopReason = params?.reason;
    this.controller.abort();
  }

  // --- the loop ----------------------------------------------------------

  private async execute(): Promise<AgentRunResult<ToolShapes, unknown>> {
    this.emit({ type: "run-start", runId: this.runId, threadId: this.params.threadId });

    try {
      // A turn that answers a sub-agent's question re-enters the tool that
      // asked it, and that tool may ask again — so the run can be finished
      // before it has taken a single model step. Going on to `loop()` here
      // would step the model with a tool call still open, which is exactly the
      // history the provider rejects.
      const escalated = await this.ingestTurn();
      if (escalated.length > 0) {
        this.finishReason = "awaiting-input";
        this.emit({ type: "awaiting-input", runId: this.runId, pending: escalated });
      } else {
        await this.loop();
      }
    } catch (error) {
      if (error instanceof RunAborted || this.controller.signal.aborted) {
        await this.finalizeAborted();
      } else {
        const normalized = this.config.provider.normalizeError(error);
        this.emit({ type: "error", error: normalized });
        await this.finalizeMessage("error");
        this.finishReason = "error";
      }
    }

    this.emit({ type: "usage", usage: this.usage });
    this.emit({ type: "run-end", runId: this.runId, finishReason: this.finishReason });
    this.ended = true;
    this.wake();

    return {
      runId: this.runId,
      messages: this.produced as AgentMessage<ToolShapes, unknown>[],
      finishReason: this.finishReason,
      usage: this.usage,
      output: this.output,
    };
  }

  private async loop(): Promise<void> {
    const maxSteps = Math.max(1, this.config.maxSteps);

    for (let step = 1; step <= maxSteps; step++) {
      const message = this.startMessage();
      const outcome = await this.runStep(message);

      if (outcome.error) {
        this.emit({ type: "error", error: outcome.error });
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
    message.finishReason = reason;
    this.emit({ type: "message-end", messageId: message.id, finishReason: reason });
    await this.report(message);
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

  private async runStep(message: AgentMessage): Promise<StepOutcome> {
    const signal = this.controller.signal;
    const provider = this.config.provider;

    let outcome: StepOutcome = { reason: "stop" };
    const partialArgs = new Map<string, { name: string; args: string }>();
    let outputText = "";

    const stream = provider.stream({
      messages: this.history.filter((m) => m !== message),
      systemPrompt: await this.systemPrompt(),
      tools: this.config.providerTools.length > 0 ? this.config.providerTools : undefined,
      output: this.config.output
        ? { name: "output", schema: this.config.output.toJSONSchema() }
        : undefined,
      reasoning: this.config.reasoning,
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
          appendText(message, "reasoning", event.delta);
          this.emit({ type: "reasoning-delta", messageId: message.id, delta: event.delta });
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
          this.emit({ type: "tool-search", loaded: event.loaded });
          break;
        }
        case "tool-call-delta": {
          const held = partialArgs.get(event.toolCallId) ?? { name: event.name, args: "" };
          held.args += event.argsDelta;
          held.name = event.name || held.name;
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
            },
          });
          break;
        }
        case "tool-call": {
          partialArgs.delete(event.toolCallId);
          const part: ToolCallPart = {
            type: "tool-call",
            toolCallId: event.toolCallId,
            name: event.name,
            // A raw string when the model produced something that is not JSON.
            // Keeping it is what makes the `invalid_tool_input` result below
            // readable instead of an empty object nobody can explain.
            input: parseArgs(event.args),
          };
          message.content.push(part);
          this.emit({ type: "tool-call", messageId: message.id, part });
          break;
        }
        case "finish": {
          this.usage = addUsage(this.usage, event.usage);
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
          outcome = { reason: "error", error: event.error };
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
      };
      message.content.push(part);
      this.emit({ type: "tool-call", messageId: message.id, part });
    }

    if (this.config.output && outputText && !outcome.error) {
      const parsed = this.config.output.safeParse(bestEffortParse(outputText));
      if (parsed.ok === true) {
        this.output = parsed.value;
        message.content.push({ type: "output", value: parsed.value });
      } else {
        this.emit({
          type: "error",
          error: {
            code: "unknown",
            message: `The model's structured answer did not match the output schema: ${parsed.errors.join(", ")}`,
            retryable: true,
          },
        });
      }
    }

    return outcome;
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

      const parsed = resolved.tool.inputSchema.safeParse(call.input);
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
          signature: signPendingCall(this.claimsFor(call.toolCallId, String(call.name), kind, parsed.value)),
          ...(this.pathPrefix.length > 0 ? { path: [...this.pathPrefix] } : {}),
        });
        continue;
      }

      running.push(
        this.executeTool(resolved, call, parsed.value, step)
          .then((result) => this.addResult(message, result))
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

    await raceAbort(Promise.all(running).then(() => undefined), this.controller.signal);
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
    call: ToolCallPart,
    input: unknown,
    step: number,
    resume?: { answers: ClientToolResult[] },
  ): Promise<ToolResultPart> {
    const ctx: ToolContext = {
      req: this.params.req,
      runId: this.runId,
      threadId: this.params.threadId,
      toolCallId: call.toolCallId,
      signal: this.controller.signal,
      step,
      depth: this.depth,
      resumed: resume !== undefined,
      runAgent: this.nestedRunner(call, resume),
    };

    try {
      const started = resolved.tool.execute!(input as any, ctx);
      let output: unknown;
      if (isAsyncGenerator(started)) {
        let next = await started.next();
        while (!next.done) {
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
      // person would do.
      return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        name: call.name,
        status: "error",
        error: {
          code: "tool_error",
          message: error instanceof Error ? error.message : String(error),
          toolCallId: call.toolCallId,
          retryable: true,
        },
      };
    }
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
    call: ToolCallPart,
    resume?: { answers: ClientToolResult[] },
  ): ToolContext["runAgent"] {
    // Snapshotted before the tool body runs: everything already here came from
    // an earlier turn and is replayable, everything appended past this point is
    // running for the first time.
    const replayable = call.nested?.length ?? 0;
    let index = 0;
    // Created on the first `runAgent` and not before, so a tool that never
    // nests does not put an empty array on every tool call it makes — the part
    // is on the wire and in the store, and an always-present `nested: []` would
    // be a shape change paid for by every app that has no sub-agents.
    const memoize = (): NestedRun[] => call.nested ?? (call.nested = []);

    return async (agent: AnyAgent, params: RunAgentParams = {}): Promise<NestedRunResult> => {
      const at = index++;
      const memo = memoize();
      const recorded = at < replayable ? memo[at] : undefined;

      if (recorded) {
        const mismatch = replayMismatch(recorded, agent, params);
        if (mismatch) {
          throw new Error(
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

      return this.runNested(call, agent, params, at, memo, recorded, resume?.answers ?? []);
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
    call: ToolCallPart,
    agent: AnyAgent,
    params: RunAgentParams,
    at: number,
    memo: NestedRun[],
    recorded: NestedRun | undefined,
    answers: ClientToolResult[],
  ): Promise<NestedRunResult> {
    // Both checks before anything starts, so the failure is a tool result the
    // model can read rather than a partly-run tree. The name chain catches the
    // common cycle (A runs A, A runs B runs A) exactly; the depth limit catches
    // the shapes a name cannot see, such as the same agent under two names.
    const chain = [...this.chain, agent.name];
    if (this.chain.includes(agent.name)) {
      throw new Error(
        `"${agent.name}" is already running further up this chain: ${chain.join(" -> ")}. An agent cannot run itself, directly or through another agent.`,
      );
    }
    const depth = this.depth + 1;
    if (depth > this.maxDepth) {
      throw new Error(
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
      turn: resuming
        ? { toolResults: mine }
        : params.prompt
          ? { text: params.prompt }
          : undefined,
      req: this.params.req,
      // Inherited, not new: this is what makes the parent's `stop()` reach a
      // sub-run three levels down without anything in between forwarding it.
      signal: this.controller.signal,
      threadId: this.params.threadId,
      instructions: params.instructions,
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
    const forwarding: Promise<void> = (async () => {
      for await (const event of sub as AsyncIterable<AgentStreamEvent>) {
        if (event.type === "awaiting-input") asked = event.pending;
        this.emit({
          type: "nested-event",
          toolCallId: call.toolCallId,
          runId: sub.runId,
          agent: agent.name,
          label,
          event,
        });
      }
    })();

    // Recording is its own promise so that the abort path can wait for exactly
    // this — the transcript reaching the tool call — rather than for the whole
    // tool, which may be ignoring the signal.
    const recording = (async () => {
      const result = await sub.result();
      await forwarding;
      const record: NestedRun = {
        runId: sub.runId,
        agent: agent.name,
        label,
        // The seed leads, because a run only reports the messages it *made*
        // and `params.messages` is not one of them. Recording the transcript
        // without its opening is two bugs: a resume re-enters the sub-agent
        // with the conversation it was started from missing, and the replay
        // check below has nothing to fingerprint the seed against. Upserted
        // rather than concatenated because the sub-run may have amended one of
        // these on its way through.
        messages: resuming
          ? mergeMessages(recorded.messages, result.messages)
          : mergeMessages(params.messages ?? [], result.messages),
        finishReason: result.finishReason,
        usage: resuming ? addUsage(recorded.usage ?? emptyUsage(), result.usage) : result.usage,
      };
      // Written before anything below can throw. An escalation is a pause, not
      // a lost run, and a cancelled sub-run is still work the user should be
      // able to read — both of those depend on the transcript already being on
      // the part when the throw happens.
      memo[at] = record;
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
        throw new Error(
          `"${agent.name}" ended awaiting input but asked nothing, so there is no question to escalate.`,
        );
      }
      throw new PendingEscalation({ pending: asked, path: signingPath, nested: record });
    }

    return {
      runId: record.runId,
      agent: agent.name,
      messages: record.messages,
      finishReason: result.finishReason,
      usage: record.usage ?? emptyUsage(),
      output: result.output ?? outputOf(record.messages),
      nested: record,
    };
  }

  private addResult(message: AgentMessage, part: ToolResultPart) {
    message.content.push(part);
    this.emit({ type: "tool-result", messageId: message.id, part });
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
          if (!this.parkedBelow(hosting.call, below, answer.toolCallId)) {
            reject(
              `The answer for "${answer.toolCallId}" is addressed under "${host}", which has no sub-agent run waiting on that question.`,
            );
            continue;
          }
          const group = reentry.get(host) ?? [];
          group.push(answer);
          reentry.set(host, group);
          // Marked answered so the refusal pass below leaves it alone: the tool
          // is about to be re-entered and will produce the real result.
          answered.add(host);
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
        // it, exactly as an escalation from the step loop does.
        if (result !== "open") this.attachToHistory(target, result);
      }

      for (const [host, answers] of reentry) {
        const entry = open.find((item) => item.call.toolCallId === host)!;
        const result = await this.reenter(entry, answers, escalated);
        if (result) this.attachToHistory(entry, result);
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

      await this.reportAmended();
    }

    if (turn && (turn.text || (turn.files && turn.files.length > 0))) {
      const message: AgentMessage = {
        id: `msg_${crypto.randomUUID()}`,
        role: "user",
        content: [
          ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
          ...(turn.files ?? []).map((file) => ({
            type: "file" as const,
            fileId: file.fileId,
            name: file.name,
            mimeType: file.mimeType,
          })),
        ],
        createdAt: new Date().toISOString(),
        finishReason: "stop",
      };
      this.history.push(message);
      this.produced.push(message);
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
   * that record arrives from the client and could say anything — but saying it
   * only buys a re-entry of a tool that really did park, whose answer still has
   * to carry a MAC the sub-run verifies. What it cannot buy is the execution of
   * a call that never ran at all.
   *
   * `below` is the answer's path with this run's prefix already removed, so
   * `below[0]` is `call` itself and `below[1]`, when there is one, names the
   * call to re-enter one level further down.
   */
  private parkedBelow(call: ToolCallPart, below: string[], toolCallId: string): boolean {
    const wanted = below.length > 1 ? below[1] : toolCallId;
    return (call.nested ?? []).some(
      (run) => run.finishReason === "awaiting-input" && openCallIds(run.messages).has(wanted),
    );
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

    const call = this.amendCall(entry);
    try {
      // Step 0, like an approval executed on the way in: this belongs to the
      // turn, not to a step of the loop that has not started yet.
      return await raceAbort(
        this.executeTool(resolved, call, call.input, 0, { answers }),
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
   * something `onMessage` can report — see `reportAmended`, which is why the
   * message is marked unreported here even though no result may ever attach.
   */
  private amendCall(entry: { message: AgentMessage; call: ToolCallPart }): ToolCallPart {
    const message = this.amend(entry.message);
    const at = message.content.indexOf(entry.call);
    const call: ToolCallPart = {
      ...entry.call,
      nested: (entry.call.nested ?? []).map((run) => ({ ...run })),
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

    // Verifying says the server once asked this exact question; spending the
    // nonce says nobody has answered it yet. Without this step a captured token
    // approves the same call every time it is presented — the client rewinds to
    // the history from before the result existed and replays, and the human who
    // approved once has approved forever.
    if (!consumePendingCall(answer.signature)) {
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
        try {
          return await raceAbort(
            this.executeTool(resolved, executing, executing.input, 0),
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
      const parsed = schema ? schema.safeParse(answer.output) : { ok: true as const, value: answer.output };
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
   * Persists the messages this run amended, once each.
   *
   * Called both at the end of `ingestTurn` and from the abort path, because a
   * stop that lands while an approved tool is running has to persist the
   * results that *did* attach this turn — otherwise the work is done, the
   * transcript on the stream shows it, and the store never hears about it.
   */
  private async reportAmended(): Promise<void> {
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
    await this.reportAmended();

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

function appendText(message: AgentMessage, type: "text" | "reasoning", delta: string) {
  const last = message.content[message.content.length - 1];
  if (last && last.type === type) {
    (last as { text?: string }).text = ((last as { text?: string }).text ?? "") + delta;
    return;
  }
  message.content.push(
    type === "text" ? { type: "text", text: delta } : { type: "reasoning", text: delta },
  );
}
