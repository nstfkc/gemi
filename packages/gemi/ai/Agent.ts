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

export class AgentTool<Name extends string = string, Input = unknown, Output = unknown> {
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
  readonly execute?: ToolExecute<Input, Output>;

  private constructor(params: ToolDefinition<Name, Input, Output>) {
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
  static create<const Name extends string, Input, Output>(
    params: ToolDefinition<Name, Input, Output>,
  ): AgentTool<Name, Input, Output> {
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

/** The tool tuple, erased to the payload types the client is allowed to see. */
export type ToolShapesOf<T extends readonly ToolEntry[]> = {
  [K in Extract<FlattenTools<T>, AnyAgentTool> as K["name"]]: K extends AgentTool<any, infer I, infer O>
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
  reasoning?: ReasoningEffort;
};

const DEFAULT_MAX_STEPS = 8;

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

  constructor(config: RunConfig, params: AgentStreamParams) {
    this.config = config;
    this.params = params;
    this.runId = params.runId ?? `run_${crypto.randomUUID()}`;
    this.history = [...params.messages];

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
      await this.ingestTurn();
      await this.loop();
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
        pending.push({
          toolCallId: call.toolCallId,
          name: call.name,
          input: parsed.value,
          kind,
          signature: signPendingCall({
            runId: this.runId,
            toolCallId: call.toolCallId,
            name: String(call.name),
            kind,
            input: parsed.value,
          }),
        });
        continue;
      }

      running.push(
        this.executeTool(resolved, call, parsed.value, step)
          .then((result) => this.addResult(message, result))
          // Only `RunAborted` reaches here, and the abort path denies every
          // unresolved call at once — swallowing it keeps a stopped run from
          // also raising an unhandled rejection.
          .catch(() => undefined),
      );
    }

    await raceAbort(Promise.all(running).then(() => undefined), this.controller.signal);
    return pending;
  }

  private async executeTool(
    resolved: ResolvedTool,
    call: ToolCallPart,
    input: unknown,
    step: number,
  ): Promise<ToolResultPart> {
    const ctx: ToolContext = {
      req: this.params.req,
      runId: this.runId,
      threadId: this.params.threadId,
      toolCallId: call.toolCallId,
      signal: this.controller.signal,
      step,
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
  private async ingestTurn(): Promise<void> {
    const turn = this.params.turn;
    const open = this.openCalls();

    if (open.length > 0) {
      const answered = new Set<string>();
      const seen = new Set<string>();

      for (const answer of turn?.toolResults ?? []) {
        // One answer per call, first one wins. A turn carrying the same entry
        // twice is a retried submit or a double-clicked form, and without this
        // it ran the approved tool twice and left two results for one
        // toolCallId — a history the provider rejects, arrived at by exactly
        // the machinery that exists to keep the history well formed.
        if (seen.has(answer.toolCallId)) continue;
        seen.add(answer.toolCallId);

        const target = open.find((entry) => entry.call.toolCallId === answer.toolCallId);
        if (!target) {
          // Nothing to attach it to, so it cannot be told to the model even as
          // an error part — a result for a call that was never made.
          this.emit({
            type: "error",
            error: {
              code: "invalid_tool_result",
              message: `No pending tool call with id "${answer.toolCallId}".`,
              toolCallId: answer.toolCallId,
              retryable: false,
            },
          });
          continue;
        }

        const result = await this.resolveAnswer(target, answer);
        if (!result) continue;
        answered.add(answer.toolCallId);
        this.attachToHistory(target, result);
      }

      for (const entry of open) {
        if (answered.has(entry.call.toolCallId)) continue;
        // The turn said something else. That is a refusal — the honest reading,
        // and the only one that cannot strand the thread.
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
   * must not see a result the server cannot vouch for.
   */
  private async resolveAnswer(
    entry: { message: AgentMessage; call: ToolCallPart },
    answer: ClientToolResult,
  ): Promise<ToolResultPart | null> {
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

    const verified = verifyPendingCall(answer.signature, {
      runId: issued.runId,
      toolCallId: call.toolCallId,
      name,
      kind,
      input: call.input,
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
        return raceAbort(
          this.executeTool(resolved, call, call.input, 0),
          this.controller.signal,
        );
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
    let message = this.amended.get(entry.message.id);
    if (!message) {
      const original = entry.message;
      message = { ...original, content: [...original.content] };
      const index = this.history.indexOf(original);
      if (index >= 0) this.history[index] = message;
      this.produced.push(message);
      this.amended.set(original.id, message);
    }
    message.content.push(result);
    this.unreported.add(message);
    this.emit({ type: "tool-result", messageId: message.id, part: result });
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
