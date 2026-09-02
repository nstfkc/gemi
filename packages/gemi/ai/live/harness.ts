/**
 * The plumbing the live suite needs, kept out of the suite so the tests read as
 * claims about the API rather than as setup.
 *
 * NOTHING IN THIS DIRECTORY READS A KEY BY VALUE. The providers pull
 * `OPENAI_API_KEY` / `AZURE_OPENAI_API_KEY` out of `process.env` themselves —
 * see `AgentProvider.endpoint()` — so the only thing this file does with a
 * credential is ask whether one is set. That is deliberate: a harness that
 * carried the key around would eventually put it in a failure message, and a
 * failure message is the one place a secret is guaranteed to be printed.
 */
import type {
  AgentProvider,
  ProviderEvent,
  ProviderStream,
  ProviderStreamParams,
} from "../AgentProvider";
import { AzureOpenAIProvider, OpenAIProvider } from "../AgentProvider";
import type { AgentMessage, AgentStreamFrame, Usage } from "../types";

/**
 * The model the suite is written against. `gpt-5.4` is not incidental: it is
 * the generation where tool search exists (see `providers/capabilities.ts`),
 * and the deferred-namespace test is the whole reason this suite exists.
 *
 * Overridable so a resource whose deployment is called something else can still
 * run — Azure lets whoever ran the template name it anything.
 */
export const LIVE_MODEL = process.env.AI_LIVE_MODEL ?? "gpt-5.4";
export const LIVE_AZURE_DEPLOYMENT =
  process.env.AI_LIVE_AZURE_DEPLOYMENT ?? process.env.AI_LIVE_MODEL ?? "gpt-5.4";

/**
 * A key alone is not enough for Azure: the provider also needs to know which
 * resource, and there are three spellings of that. Checking for all three is
 * what stops the suite from running and failing with a 404 for a contributor
 * who exported the key and nothing else.
 */
export const AZURE_RESOURCE_VARS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_RESOURCE_NAME",
] as const;

export const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
export const azureConfigured =
  Boolean(process.env.AZURE_OPENAI_API_KEY) &&
  AZURE_RESOURCE_VARS.some((name) => Boolean(process.env[name]));

/**
 * A provider that records what went through it and caps what it costs.
 *
 * Two jobs, and both are load-bearing rather than convenience:
 *
 * `calls` is evidence. The memoization claim in the escalation test — that a
 * sub-run which finished on turn one is replayed from the transcript rather
 * than run again — is not observable from the transcript, because a replayed
 * run and a re-run one produce the same messages. The only difference is
 * whether a request was made, so the test counts requests.
 *
 * `maxOutputTokens` is a cap `Agent` has no way to set: `AgentStreamParams`
 * carries no token budget, deliberately, and `ProviderStreamParams` does. So
 * the cap goes on the seam between them. Without it a reasoning model asked a
 * puzzle can spend thousands of tokens deciding how to say "nine".
 */
export class RecordingProvider implements AgentProvider {
  readonly model: string;
  readonly capabilities: AgentProvider["capabilities"];
  /** One entry per model call, in order. */
  readonly requests: ProviderStreamParams[] = [];
  /** Every `ProviderEvent` the parser produced, flattened across calls — this
   *  is where the tool-search and namespace assertions read from, because
   *  `AgentStreamEvent` carries only half of what the parser knows. */
  readonly events: ProviderEvent[] = [];

  constructor(
    private readonly inner: AgentProvider,
    private readonly maxOutputTokens: number,
  ) {
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  get calls(): number {
    return this.requests.length;
  }

  /**
   * What the provider itself reported spending, summed over every call.
   *
   * Deliberately a second implementation of `Agent`'s `addUsage` rather than a
   * call to it: the claim being checked is that the run's total is the sum of
   * what the provider billed, and asking the accumulator whether it accumulated
   * would check nothing. The optional members follow the same rule the real one
   * does — present as soon as any call reported them, so a run whose provider
   * never mentions reasoning tokens keeps the smaller shape.
   */
  spent(): Usage {
    const total: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const event of this.events) {
      if (event.type !== "finish") continue;
      total.inputTokens += event.usage.inputTokens ?? 0;
      total.outputTokens += event.usage.outputTokens ?? 0;
      total.totalTokens += event.usage.totalTokens ?? 0;
      if (event.usage.reasoningTokens !== undefined || total.reasoningTokens !== undefined) {
        total.reasoningTokens = (total.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0);
      }
      if (event.usage.cachedInputTokens !== undefined || total.cachedInputTokens !== undefined) {
        total.cachedInputTokens =
          (total.cachedInputTokens ?? 0) + (event.usage.cachedInputTokens ?? 0);
      }
    }
    return total;
  }

  stream(params: ProviderStreamParams): ProviderStream {
    this.requests.push(params);
    const events = this.events;
    const inner = this.inner.stream({ ...params, maxOutputTokens: this.maxOutputTokens });
    return (async function* () {
      for await (const event of inner) {
        events.push(event);
        yield event;
      }
    })();
  }

  upload(file: File): Promise<string> {
    return this.inner.upload(file);
  }

  normalizeError(error: unknown) {
    return this.inner.normalizeError(error);
  }
}

/** Long enough for `reasoning: "high"` to think and still answer; short enough
 *  that a runaway generation is a cent rather than a dollar. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;

export type LiveTarget = {
  /** Appears in every suite name, so `vitest -t openai` selects one provider. */
  label: "openai" | "azure";
  provider: (maxOutputTokens?: number) => RecordingProvider;
};

export const TARGETS: LiveTarget[] = [
  {
    label: "openai",
    provider: (max = DEFAULT_MAX_OUTPUT_TOKENS) =>
      new RecordingProvider(OpenAIProvider.model(LIVE_MODEL), max),
  },
  {
    label: "azure",
    provider: (max = DEFAULT_MAX_OUTPUT_TOKENS) =>
      new RecordingProvider(AzureOpenAIProvider.model(LIVE_AZURE_DEPLOYMENT), max),
  },
];

export const configuredFor = (label: LiveTarget["label"]) =>
  label === "openai" ? openaiConfigured : azureConfigured;

// --- reading a transcript -------------------------------------------------

export const textOf = (message: AgentMessage | undefined): string =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part: any) => part.text as string)
    .join("");

export const partsOf = (messages: AgentMessage[], type: string): any[] =>
  messages.flatMap((message) => message.content.filter((part) => part.type === type)) as any[];

export const lastOf = <T>(items: T[]): T => items[items.length - 1];

/** Every text part in the run, joined — what the user ends up reading. */
export const transcriptText = (messages: AgentMessage[]) => messages.map(textOf).join("\n");

/**
 * The same text with digit grouping removed, for the assertions that look for a
 * number the tool produced.
 *
 * A model writes 7413 as "7,413" about half the time, and on a French system
 * prompt it would write "7 413". Stripping the separators is not a weaker
 * assertion — it is the same number — and the alternative, telling the model
 * how to format its digits, would make the test pass by changing what is being
 * measured.
 */
export const withoutDigitGrouping = (text: string) =>
  text.replace(/(?<=\d)[,\u202f\u00a0 ](?=\d)/g, "");

/**
 * Drains a run's numbered frames while it is still going, twice over.
 *
 * `frames()` rather than the plain async iterator because half the claims in
 * this suite are about `seq` — that nested events are numbered in the parent's
 * sequence, and that a client replaying them lands on the same transcript.
 *
 * WHY TWO ARRAYS, AND WHY THIS IS NOT PEDANTRY. A `tool-call` frame carries the
 * `ToolCallPart` BY REFERENCE, and the part goes on being written to after the
 * frame is emitted: `nestedRunner` hangs `nested` on it, and the sub-run's
 * transcript grows there for the rest of the call. In process, that means a
 * frame collected at the top of a run has a *different* value by the end of it.
 *
 * `AgentRunImpl.toResponse` does `JSON.stringify(frame.event)` at yield time,
 * so a browser watching live receives the part as it was when the frame went
 * out — which is what `wire` is: a clone taken the instant the frame arrived.
 * That is the only honest input for a test of the client reducer. Feeding the
 * live objects instead would hand the reducer a nested transcript it never had
 * to build, and a reducer that dropped `nested-event` entirely would still
 * pass. (It did. That is how this was found.)
 *
 * `live` is kept because the other shape is real too: a client that calls
 * `/attach?from=0` after the run has finished gets the buffered frames
 * serialized *then*, nested transcript already on the part, and then every
 * `nested-event` again on top of it. Converging from there is a claim worth
 * making rather than an accident worth relying on.
 */
export function collectFrames(run: { frames(from?: number): AsyncIterable<AgentStreamFrame> }) {
  const wire: AgentStreamFrame[] = [];
  const live: AgentStreamFrame[] = [];
  const done = (async () => {
    for await (const frame of run.frames()) {
      live.push(frame);
      wire.push(JSON.parse(JSON.stringify(frame)) as AgentStreamFrame);
    }
  })();
  return { wire, live, done };
}

/** The request that has no user in it: these tests call `Agent.stream` directly
 *  rather than through the controller, and no tool here reads the request. */
export const req = {} as any;
