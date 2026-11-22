import {
  AgentProvider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderStreamParams,
} from "../AgentProvider";
import { splitTurns } from "../contextWindow";
import type { AgentError, AgentMessage, FinishReason, Usage } from "../types";

/**
 * One model call's answer in a `scriptedProvider` script:
 *
 * - a string: a text reply;
 * - `{ text?, reasoning?, output?, toolCalls?, finishReason?, usage? }`: a
 *   reply with tool calls, reasoning or structured output (`output` is
 *   sent as its JSON);
 * - `{ events }`: the provider events themselves, for what the shorthand
 *   does not cover;
 * - `{ error }`: the call fails with it;
 * - a function of the call (`ScriptedCall`) answering one of these, for an
 *   answer that depends on what was sent.
 */
export type ScriptedStep =
  | string
  | ScriptedReply
  | { events: ProviderEvent[] }
  | { error: Error | string }
  | ((call: ScriptedCall) => ScriptedStep | Promise<ScriptedStep>);

/** A step that is not a function: what a function step comes to. */
type ResolvedStep = Exclude<ScriptedStep, (call: ScriptedCall) => unknown>;

export type ScriptedReply = {
  text?: string;
  reasoning?: string;
  /** Structured output (an agent with `output`), sent as JSON. */
  output?: unknown;
  /** `id` defaults to `call_<agent>_<call>_<n>`; `input` to `{}`. */
  toolCalls?: { name: string; input?: unknown; id?: string }[];
  /** Default `"stop"`, tool calls or not: the run goes on to run them. */
  finishReason?: FinishReason;
  /** Default one input and one output token. */
  usage?: Usage;
};

/** A call a `scriptedProvider` answered, as its steps and `calls` see it. */
export type ScriptedCall = {
  /** The agent that made it (`ProviderStreamParams.agent`), `undefined` for a call no agent made. */
  agent: string | undefined;
  /** 0 for a run, 1 for a sub-agent it called, and so on. */
  depth: number;
  /** Which of this agent's calls it is, from 0. */
  index: number;
  /** What the call sent. */
  messages: AgentMessage[];
  /** The user turn the call answers: `turnOf(messages)`. */
  turn: ScriptedTurn | undefined;
  params: ProviderStreamParams;
};

/** A user turn, as `turnOf` finds it. */
export type ScriptedTurn = {
  /** The user message that started the turn. */
  message: AgentMessage;
  /** Its text parts, joined. */
  text: string;
  /** Every message of the turn, the one that started it first. */
  messages: AgentMessage[];
};

export type ScriptedProviderOptions = {
  /**
   * What a call does once its script has no step left: `"throw"` (the
   * default) fails it with a `ScriptedProviderError` that names the agent,
   * the call and its turn; `"stop"` answers an empty reply.
   */
  exhausted?: "throw" | "stop";
};

/** A call a `scriptedProvider` had no step for. The run ends with a `provider_error` carrying its message. */
export class ScriptedProviderError extends Error {
  override name = "ScriptedProviderError";
}

/**
 * The user turn the last of `messages` belongs to (#1343): the user message
 * that started it, its text, and the turn's messages. Grouped as
 * `splitTurns` groups (a tool's results and the files it showed are part of
 * the turn that called it; a message that joined a turn goes with it), so a
 * provider reading it does not depend on how a step's messages are laid
 * out. `undefined` when no user message started the last turn.
 */
export function turnOf(messages: readonly AgentMessage[]): ScriptedTurn | undefined {
  const turns = splitTurns(messages);
  const last = turns.at(-1);
  const message = last?.find((candidate) => candidate.role === "user");
  if (!last || !message) return undefined;
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return { message, text, messages: last };
}

/** The key of a script for every call. */
const ANY = undefined;

const CAPABILITIES: ProviderCapabilities = {
  reasoning: true,
  structuredOutput: true,
  fileInput: true,
  parallelToolCalls: true,
  toolSearch: true,
};

/**
 * A provider for tests that answers each call from a script (#1343).
 *
 * Give it one script per agent, by name, and each agent's calls take the
 * next step of its own script, whatever order the agents call in:
 *
 *     const provider = scriptedProvider({
 *       planner: [{ toolCalls: [{ name: "research", input: { topic: "tea" } }] }, "Here is the plan."],
 *       researcher: ["Green tea has less caffeine."],
 *     });
 *
 * Or one list for every call, whichever agent makes it:
 *
 *     scriptedProvider(["Hello!", "Goodbye."]);
 *
 * A call with no step left fails with a `ScriptedProviderError` (see
 * `exhausted`), as does one from an agent the scripts do not name. `calls`
 * keeps every call; `assertDone()` throws when a step was never used.
 */
export class ScriptedProvider extends AgentProvider {
  readonly model = "scripted";
  readonly capabilities = CAPABILITIES;
  /** Every call, in the order they were made. */
  readonly calls: ScriptedCall[] = [];
  /** Every upload, in order: each gets the id `file_<n>`. */
  readonly uploads: File[] = [];

  private readonly steps: Map<string | undefined, ScriptedStep[]>;
  private readonly used = new Map<string | undefined, number>();

  constructor(
    script: ScriptedStep[] | Record<string, ScriptedStep[]>,
    private readonly options: ScriptedProviderOptions = {},
  ) {
    super();
    this.steps = Array.isArray(script)
      ? new Map([[ANY, [...script]]])
      : new Map(Object.entries(script).map(([name, steps]) => [name, [...steps]]));
  }

  /** The calls `agent` made. */
  callsOf(agent: string): ScriptedCall[] {
    return this.calls.filter((call) => call.agent === agent);
  }

  /** Throws when a script has a step no call took. */
  assertDone(): void {
    const left = [...this.steps].flatMap(([key, steps]) => {
      const unused = steps.length - (this.used.get(key) ?? 0);
      return unused > 0 ? [`${key === ANY ? "the script" : `"${key}"`}: ${unused} step(s)`] : [];
    });
    if (left.length > 0) throw new ScriptedProviderError(`Steps never used: ${left.join(", ")}.`);
  }

  stream(params: ProviderStreamParams) {
    const agent = params.agent?.name;
    const key = this.steps.has(ANY) ? ANY : agent;
    const index = this.used.get(key) ?? 0;
    const call: ScriptedCall = {
      agent,
      depth: params.agent?.depth ?? 0,
      index: this.calls.filter((other) => other.agent === agent).length,
      messages: params.messages,
      turn: turnOf(params.messages),
      params,
    };
    this.calls.push(call);
    const steps = this.steps.get(key);
    const step = steps?.[index];
    if (steps && step !== undefined) this.used.set(key, index + 1);
    const missing = () => {
      const who = agent === undefined ? "A call no agent made" : `Agent "${agent}"`;
      const turn = call.turn ? ` (turn: ${JSON.stringify(call.turn.text.slice(0, 80))})` : "";
      if (!steps) {
        const named = [...this.steps.keys()].map((name) => `"${name}"`).join(", ");
        return `${who} has no script${turn}. The scripts are for ${named}.`;
      }
      return `${who} made call ${call.index + 1}, and its script has ${steps.length} step(s)${turn}.`;
    };
    const exhausted = this.options.exhausted ?? "throw";
    return (async function* (): AsyncGenerator<ProviderEvent> {
      if (step === undefined) {
        if (exhausted === "throw") throw new ScriptedProviderError(missing());
        yield finish("stop");
        return;
      }
      yield* eventsOf(await resolve(step, call), call);
    })();
  }

  async upload(file: File) {
    this.uploads.push(file);
    return `file_${this.uploads.length}`;
  }

  override normalizeError(error: unknown): AgentError {
    return {
      code: "provider_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

/** A `ScriptedProvider` (see there): one script for every call, or one per agent, by name. */
export function scriptedProvider(
  script: ScriptedStep[] | Record<string, ScriptedStep[]>,
  options?: ScriptedProviderOptions,
): ScriptedProvider {
  return new ScriptedProvider(script, options);
}

async function resolve(step: ScriptedStep, call: ScriptedCall): Promise<ResolvedStep> {
  let current = step;
  while (typeof current === "function") current = await current(call);
  return current;
}

const finish = (reason: FinishReason, usage?: Usage): ProviderEvent => ({
  type: "finish",
  reason,
  usage: usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

function eventsOf(step: ResolvedStep, call: ScriptedCall): ProviderEvent[] {
  if (typeof step === "string") return [{ type: "text-delta", delta: step }, finish("stop")];
  if ("events" in step) return step.events;
  if ("error" in step) throw typeof step.error === "string" ? new ScriptedProviderError(step.error) : step.error;
  const events: ProviderEvent[] = [];
  if (step.reasoning) events.push({ type: "reasoning-delta", delta: step.reasoning });
  if (step.text) events.push({ type: "text-delta", delta: step.text });
  if (step.output !== undefined) events.push({ type: "output-delta", delta: JSON.stringify(step.output) });
  (step.toolCalls ?? []).forEach((toolCall, n) => {
    events.push({
      type: "tool-call",
      toolCallId: toolCall.id ?? `call_${call.agent ?? "any"}_${call.index}_${n}`,
      name: toolCall.name,
      args: JSON.stringify(toolCall.input ?? {}),
    });
  });
  events.push(finish(step.finishReason ?? "stop", step.usage));
  return events;
}
