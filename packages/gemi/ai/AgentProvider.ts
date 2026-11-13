import type { ReasoningEffort } from "./Agent";
import {
  responsesEndpoint,
  streamResponses,
  uploadFile,
  type ResponsesEndpoint,
} from "./providers/call";
import {
  buildMessagesRequest,
  recoverableRequestError,
  THINKING_BINDING_BETA,
  withoutThinkingBlocks,
  type MessagesRequest,
} from "./providers/anthropicRequest";
import { parseMessagesStream } from "./providers/anthropicStream";
import {
  capabilitiesForClaude,
  capabilitiesForModel,
  supportsForcedToolChoice,
} from "./providers/capabilities";
import {
  anthropicTarget,
  azureRealtimeTarget,
  foundryTarget,
  type AnthropicConfig,
  type FoundryConfig,
  azureTarget,
  openAITarget,
  type AzureConfig,
  type ProviderConfig,
  type ProviderTarget,
} from "./providers/endpoints";
import { normalizeProviderError } from "./providers/errors";
import { sentFiles } from "./providers/fileRejection";
import { RealtimeClient, DEFAULT_REALTIME_TIMEOUT_MS } from "./providers/realtime";
import { isContentEvent } from "./runtime";
import { buildResponsesRequest } from "./providers/request";
import type { JSONSchema } from "./Schema";
import type { AgentError, AgentMessage, FinishReason, ToolArgumentsTooLong, Usage } from "./types";

/**
 * A provider makes one model call. It does not run the tool loop.
 *
 * The split matters: approvals, `maxSteps`, deferred tools, skill loading and
 * persistence are all provider-independent, and putting them in the provider
 * would mean writing them again for the second provider. So the provider's
 * whole job is to translate gemi's messages into a request, and the response
 * stream back into `ProviderEvent`s. Everything above that lives in `Agent`.
 *
 * v1 targets OpenAI's Responses API — native reasoning items and strict
 * structured output without reassembling them by hand. The interface is kept
 * free of anything Responses-specific so a Chat Completions provider (for older
 * Azure deployments and OpenAI-compatible gateways) can be added later without
 * touching Agent, Controller or the client.
 */

/** What a provider will actually honour, so `Agent` can drop the rest rather
 *  than have a request rejected at runtime. */
export type ProviderCapabilities = {
  reasoning: boolean;
  structuredOutput: boolean;
  fileInput: boolean;
  parallelToolCalls: boolean;
  /**
   * Tool search, and with it deferred loading. Only recent models have it, so a
   * provider that answers `false` is sent every schema inline and the agent
   * runs identically — deferral is a token optimization, and an optimization
   * that changed behaviour when unavailable would not be one.
   */
  toolSearch: boolean;
};

/** A tool as the model is shown it: schema only, no implementation. */
export type ProviderToolSpec = {
  name: string;
  description: string;
  parameters: JSONSchema;
  strict: boolean;
  /** `defer_loading`: send the name and description, withhold the schema until
   *  the model searches for it. Ignored when `capabilities.toolSearch` is
   *  false. */
  deferred?: boolean;
};

/** Tools grouped for search. Flattened back to a list by a provider without
 *  tool search, since the grouping exists to be searched. */
export type ProviderToolNamespace = {
  name: string;
  description: string;
  tools: ProviderToolSpec[];
};

/** See `ProviderStreamParams.toolChoice`. */
export type ProviderToolChoice = "auto" | "required" | "none" | { name: string };

export interface ProviderStreamParams {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: (ProviderToolSpec | ProviderToolNamespace)[];
  /**
   * Whether the model must call a tool on this call (#1010): `"auto"` (it
   * chooses, the provider's default), `"required"` (some tool), `"none"` (no
   * tool, though `tools` is still sent so the prompt prefix stays the same),
   * or `{ name }` (that tool). Unset: the provider's default. Set by
   * `PrepareStepResult.toolChoice`.
   */
  toolChoice?: ProviderToolChoice;
  /**
   * Sent as `prompt_cache_key` (#1223): requests with the same key and prefix
   * share a prompt cache. Set by `Agent` from `promptCacheKey`.
   */
  promptCacheKey?: string;
  /** Set when the agent declares an `output` schema; the provider turns it into
   *  whatever its own strict-JSON parameter is. `strict` comes from the schema —
   *  false when it contains an `s.json()` node, which strict mode cannot
   *  express — and is required rather than defaulted so that a new caller has to
   *  answer it instead of inheriting a 400. */
  output?: { name: string; schema: JSONSchema; strict: boolean };
  /** Optional: silently dropped by a provider whose `capabilities.reasoning`
   *  is false, since a model that cannot reason should not fail a request. */
  reasoning?: ReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * The events of a single model call. Deliberately smaller than
 * `AgentStreamEvent`: no run, message, tool-result or approval events, because
 * a provider knows about none of those.
 */
export type ProviderEvent =
  | { type: "text-delta"; delta: string }
  /**
   * `providerMetadata` is what the provider needs to send the part back, kept
   * on `ReasoningPart.providerMetadata` (#477). Sent once, on the part's last
   * delta, which closes the part: the next reasoning delta starts a new one.
   */
  | {
      type: "reasoning-delta";
      delta: string;
      id?: string;
      providerMetadata?: Record<string, unknown>;
    }
  /** Arguments arrive as JSON fragments; the provider passes them through and
   *  `Agent` assembles and validates against the tool's schema. */
  | {
      type: "tool-call-delta";
      toolCallId: string;
      name: string;
      argsDelta: string;
      namespace?: string;
    }
  /**
   * `name` IS FLAT AND STAYS FLAT. This was an open question and the API has
   * answered it: a call to a function that lives inside a namespace comes back
   * as `{name: "getOrder", namespace: "crm"}`, not as `"crm.getOrder"` —
   * recorded in `providers/__fixtures__/openai-tool-search.sse` and pinned by
   * a test that reads that file. So `name` is already the key `Agent`'s tool
   * registry is built on, which is what makes tool names having to be globally
   * unique within an agent (see `ToolNamespace`) the right rule rather than an
   * inconvenience.
   *
   * `namespace` is carried beside it, absent for a tool that was listed bare.
   * It is provenance, not identity: it says which group the model chose to
   * look in, which is worth recording next to the call and is worthless for
   * finding the tool. Folding it into `name` would make a name that is
   * sometimes qualified and sometimes not, and nothing could match on that.
   */
  | { type: "tool-call"; toolCallId: string; name: string; args: string; namespace?: string }
  /**
   * The provider is asking the model again, and the calls named here, which
   * only ever streamed `tool-call-delta` and never completed, are void (#1169).
   * A stream that broke (or was cut as a runaway) before anything but argument
   * deltas had been sent is retried like one that broke before its first
   * content event, and this is how the deltas already passed on are taken
   * back: `Agent` forgets the calls and tells the client to drop them, so the
   * retried answer does not sit beside a half-written call that will never
   * run. A provider that never retries after a delta need not send this.
   */
  | { type: "tool-call-discard"; toolCallIds: string[] }
  /**
   * The model went looking for a deferred tool and pulled its schema in. Worth
   * surfacing rather than swallowing: it is a step the user paid for, and the
   * pause before it is otherwise unexplained.
   *
   * TWO FIELDS, not one. `loaded` is the function names — `["listOrders",
   * "getOrder"]` — and `namespaces` is the groups they came out of —
   * `["crm"]`. Search results arrive as a tree of namespaces containing
   * functions, so a single flat list has to pick one level and throw the other
   * away, and both levels are worth saying: "searched crm, loaded getOrder"
   * reads better than either half, and the group is the thing the model
   * actually chose between.
   *
   * `namespaces` is required rather than optional because the parser always
   * knows the answer, and an optional field would let a future provider forget
   * to fill it in silently. Empty means the search returned bare functions.
   */
  /**
   * `arguments` is the query the model searched with, as the provider sent it
   * (`{paths: ["crm"]}` on the Responses API), when it said. Kept so the
   * search can be replayed on later requests (#776); see `ToolSearchRecord`.
   */
  | { type: "tool-search"; loaded: string[]; namespaces: string[]; arguments?: unknown }
  | { type: "output-delta"; delta: string }
  /**
   * `model` is the model the vendor says produced the response (`response.model`
   * on the Responses API), which is not always the one asked for: an Azure
   * deployment name answers with the model behind it, and an alias like
   * `gpt-5.4` with a dated snapshot. Absent when the vendor did not say — a
   * request that failed before any response, or a provider that does not know.
   * Optional so a custom provider need not fill it in (#741).
   */
  | { type: "finish"; reason: FinishReason; usage: Usage; model?: string }
  /**
   * `status` and `requestId` describe the HTTP response the error came from,
   * when there was one. They are for the server's record of the run
   * (`AgentRunResult.error`) and are never written to a client frame; leave
   * them out for an error that was not a response.
   */
  /**
   * The provider refused a stored file (`fileId` is the provider's id) and the
   * call was sent again with a note in the file's place, so the turn goes on.
   * `Agent` marks the stored `FilePart` `providerRejected`, which makes later
   * requests send the note instead of the id — otherwise the same refusal
   * costs a failed request on every turn of the thread (#684). `message` is
   * the provider's, for the log. A provider that never retries need not send
   * this; `Agent` treats its absence as nothing having been rejected.
   */
  | { type: "file-rejected"; fileId: string; message: string; status?: number; requestId?: string }
  /**
   * An attempt failed and the provider is about to ask again (#1192), sent
   * before the backoff wait, so it arrives while the call is still waiting
   * rather than after. Informational only: it is not content, it commits
   * nothing, and a consumer that ignores it loses nothing. See
   * `ProviderRetryInfo` for the fields. A provider that never retries need not
   * send it.
   */
  | ({ type: "retry" } & ProviderRetryInfo)
  | {
      type: "error";
      error: AgentError;
      status?: number;
      requestId?: string;
      /** Set when the call was cut at `maxToolArgumentChars` (#1259). */
      toolArgumentsTooLong?: ToolArgumentsTooLong;
    };

/**
 * One failed attempt of a provider call that is about to be asked again.
 *
 * - `attempt`: the attempt that failed, from 1. The next one is `attempt + 1`.
 * - `maxRetries`: the provider's `maxRetries`, so `attempt <= maxRetries`.
 * - `error`: the failure, normalized; `status` and `requestId` describe the
 *   HTTP response it came from, when there was one.
 * - `phase`: `"request"` when no response arrived (or an error status did),
 *   `"stream"` when the response started and its body broke before the first
 *   content event.
 * - `timedOut`: the attempt was cut by `timeoutMs`, `streamIdleTimeoutMs` or
 *   `streamMaxDurationMs`.
 * - `delayMs`: how long the provider waits before the next attempt.
 * - `elapsedMs`: since the call's first attempt started.
 */
export type ProviderRetryInfo = {
  attempt: number;
  maxRetries: number;
  error: AgentError;
  status?: number;
  requestId?: string;
  phase: "request" | "stream";
  timedOut: boolean;
  delayMs: number;
  elapsedMs: number;
};

export type ProviderStream = AsyncIterable<ProviderEvent>;

/**
 * Re-exported rather than declared here. What these configure is the *vendor*,
 * not the Responses API, and the images path resolves the same host, credential
 * and api-version from the same fields — see `providers/endpoints.ts` for why
 * that resolution lives in one place and what happens when it does not.
 */
export type { AnthropicConfig, AzureConfig, FoundryConfig, ProviderConfig } from "./providers/endpoints";

export abstract class AgentProvider {
  abstract readonly model: string;
  abstract readonly capabilities: ProviderCapabilities;

  /** The model ids this provider knows about — for autocomplete only; any
   *  string is still accepted, because a new model must not require a gemi
   *  release to use. */
  static models(): readonly string[] {
    return [];
  }

  abstract stream(params: ProviderStreamParams): ProviderStream;

  /**
   * Uploads a file and returns the id a `FilePart` carries. Message history
   * therefore holds provider file ids, which is the trade for getting vision
   * and PDF input without gemi owning a storage story in v1.
   */
  abstract upload(file: File): Promise<string>;

  /**
   * Maps a provider's error body onto the normalized codes, so an app can
   * branch on `rate_limited` without knowing whose rate limit it was.
   *
   * Shared rather than abstract-in-practice: Azure answers the same error
   * envelope as OpenAI, and the one place it differs — the content filter's
   * code, buried in `innererror` — is handled by reading both.
   */
  normalizeError(error: unknown): AgentError {
    return normalizeProviderError(error);
  }
}

/**
 * Autocomplete, not a gate. Every id here was confirmed present in
 * `GET https://api.openai.com/v1/models`; any other string is still accepted,
 * because a model released next Tuesday must not need a gemi release to use —
 * see `capabilitiesForModel` for what an unrecognized id is assumed to do.
 *
 * Ordered newest first, and deliberately short. `/v1/models` answers with
 * ninety-odd chat ids once the dated snapshots and the `-codex`, `-pro`,
 * `-chat-latest`, `-search-api` and `-nano` variants are counted; a list that
 * tried to be complete would be stale within the month and would bury the
 * handful of names anyone actually types. Snapshot-pinned ids
 * (`gpt-5.4-2026-03-05`) are left out for the same reason and work identically.
 *
 * The Azure provider returns this same list, which is a small lie it has always
 * told: a resource serves the deployments someone created, not the catalogue.
 * `AzureConfig.deployment` is the escape hatch, and an unrecognized deployment
 * name lands on the same capable default as an unrecognized model.
 */
const OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
  "o3",
  "o3-mini",
] as const;

export class OpenAIProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  protected readonly config: ProviderConfig;

  constructor(model: string, config: ProviderConfig = {}) {
    super();
    this.model = model;
    this.capabilities = capabilitiesForModel(model);
    this.config = config;
  }

  /** Config defaults come from gemi's config (`ai.openai`), so an app that has
   *  set `OPENAI_API_KEY` writes only the model name. */
  static model(model: string, config?: ProviderConfig): OpenAIProvider {
    return new OpenAIProvider(model, config);
  }

  static models(): readonly string[] {
    return OPENAI_MODELS;
  }

  stream(params: ProviderStreamParams): ProviderStream {
    const body = buildResponsesRequest(params, {
      model: this.model,
      capabilities: this.capabilities,
    });
    return streamResponses(this.endpoint(), body, {
      signal: params.signal,
      // The request carries the schema whenever the agent declared one, so the
      // parser has to read the answer as one too — a model that ignored the
      // parameter answers 400, not prose.
      structuredOutput: Boolean(params.output),
      files: sentFiles(params.messages),
    });
  }

  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file);
  }

  protected endpoint(): ResponsesEndpoint {
    return responsesEndpoint(openAITarget(this.config));
  }

  /**
   * Realtime (voice) calls on this provider's account: `createCall`,
   * `clientSecret`, `sideband` and `hangup`. The provider's model is the call's
   * default model, so build it with a realtime one
   * (`OpenAIProvider.model("gpt-realtime-mini").realtime`). See
   * `providers/realtime.ts`.
   *
   * @experimental Not yet verified against a live call.
   */
  get realtime(): RealtimeClient {
    return new RealtimeClient(
      openAITarget(this.config, { timeoutMs: DEFAULT_REALTIME_TIMEOUT_MS }),
      { model: this.model },
    );
  }
}

/**
 * The current Claude models, newest family first. Autocomplete, not a gate,
 * like `OPENAI_MODELS`: any id is accepted, and `capabilitiesForClaude` says
 * what an unknown one is assumed to do.
 */
const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/**
 * Claude on Anthropic's Messages API (`POST /v1/messages`), with an API key.
 *
 * The same request path as the OpenAI providers below the request body:
 * `streamResponses` does the retries, the stream limits and the holding back
 * until the first content event, and `parseMessagesStream` reads the stream.
 * `baseURL` (or `ANTHROPIC_BASE_URL`) points it at a gateway; see
 * `anthropicTarget`. `AzureAnthropicProvider` is the Azure AI Foundry
 * variant; Bedrock and Vertex are not covered.
 */
export class AnthropicProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  protected readonly config: AnthropicConfig;

  constructor(model: string, config: AnthropicConfig = {}) {
    super();
    this.model = model;
    this.capabilities = capabilitiesForClaude(model);
    this.config = config;
  }

  /**
   * `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID`) from the environment
   * unless `config.apiKey` (`config.workspaceId`) is set.
   */
  static model(model: string, config?: AnthropicConfig): AnthropicProvider {
    return new AnthropicProvider(model, config);
  }

  static models(): readonly string[] {
    return CLAUDE_MODELS;
  }

  stream(params: ProviderStreamParams): ProviderStream {
    return this.send(params);
  }

  /**
   * One call, asked again at most once per kind of 400 that a changed request
   * answers (`recoverableRequestError`): a thinking block bound to another
   * conversation, with the thinking blocks stripped, and a schema too complex
   * to compile, with the answer asked for in the prompt. Only before anything
   * was yielded, which a 400 always is.
   */
  private async *send(params: ProviderStreamParams): ProviderStream {
    let request = params;
    let stripThinking = false;
    const tried = new Set<string>();
    for (;;) {
      let body = this.request(request);
      if (stripThinking) body = withoutThinkingBlocks(body);
      let recover: "thinking" | "schema" | undefined;
      let yielded = false;
      for await (const event of streamResponses(this.endpointFor(body), body, {
        signal: params.signal,
        structuredOutput: Boolean(params.output),
        parse: parseMessagesStream,
      })) {
        if (recover) continue;
        if (!yielded && event.type === "error" && event.status === 400) {
          const kind = recoverableRequestError(event.error.message);
          if (kind && !tried.has(kind)) {
            tried.add(kind);
            recover = kind;
            continue;
          }
        }
        if (isContentEvent(event)) yielded = true;
        yield event;
      }
      if (!recover) return;
      if (recover === "thinking") stripThinking = true;
      else if (request.output) request = { ...request, output: { ...request.output, strict: false } };
    }
  }

  private request(params: ProviderStreamParams): MessagesRequest {
    return buildMessagesRequest(params, {
      model: this.deployment(),
      modelId: this.model,
      capabilities: this.capabilities,
      forcedToolChoice: supportsForcedToolChoice(this.model),
      blockBinding: this.bindsThinking(),
    });
  }

  /** The beta header goes with the body that needs it. */
  private endpointFor(body: MessagesRequest): ResponsesEndpoint {
    const endpoint = this.endpoint();
    const binding = body.thinking?.type === "adaptive" && body.thinking.block_binding;
    if (!binding) return endpoint;
    return {
      ...endpoint,
      headers: async () => {
        const headers = await endpoint.headers();
        const beta = headers["anthropic-beta"];
        return { ...headers, "anthropic-beta": beta ? `${beta},${THINKING_BINDING_BETA}` : THINKING_BINDING_BETA };
      },
    };
  }

  /** Whether `thinking.block_binding` and its beta header can be sent. */
  protected bindsThinking(): boolean {
    return true;
  }

  /** The `model` the request names. */
  protected deployment(): string {
    return this.model;
  }

  /** Through the Files API (`POST /v1/files`), which takes no `purpose`. */
  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file, null);
  }

  protected endpoint(): ResponsesEndpoint {
    return messagesEndpoint(anthropicTarget(this.config));
  }
}

function messagesEndpoint(target: ProviderTarget): ResponsesEndpoint {
  return { ...responsesEndpoint(target), responsesUrl: `${target.base}/messages` };
}

/**
 * Claude on Azure AI Foundry, which serves the same Messages API under the
 * resource's `/anthropic` path, so this is `AnthropicProvider` with another
 * endpoint and auth (see `foundryTarget`) and, as with `AzureOpenAIProvider`,
 * a deployment name that can differ from the model id. Capabilities are read
 * off the model, as there.
 *
 * NO FILES. The Files API is a 400 on deployments hosted on Azure (the
 * default hosting) and a beta on the ones hosted on Anthropic, so
 * `fileInput` is false and `upload()` refuses: a file a user attaches is
 * stored by gemi and named to the model by its attachment id, for a tool to
 * read. Everything else the agent uses (streaming, tools, thinking, structured
 * output, prompt caching) is supported on both hostings. Thinking is not
 * bound (`bindsThinking`).
 */
export class AzureAnthropicProvider extends AnthropicProvider {
  declare readonly capabilities: ProviderCapabilities;
  protected declare readonly config: FoundryConfig;

  constructor(model: string, config: FoundryConfig = {}) {
    super(model, config);
    this.capabilities = { ...capabilitiesForClaude(model), fileInput: false };
  }

  /** `ANTHROPIC_FOUNDRY_*` from the environment for what `config` leaves out. */
  static override model(model: string, config?: FoundryConfig): AzureAnthropicProvider {
    return new AzureAnthropicProvider(model, config);
  }

  override upload(_file: File): Promise<string> {
    return Promise.reject(
      new Error(
        "AzureAnthropicProvider does not upload files: the Files API is not available on Azure-hosted Foundry deployments. The file is still stored by gemi and named to the model by its attachment id.",
      ),
    );
  }

  protected override deployment(): string {
    return this.config.deployment ?? this.model;
  }

  /**
   * Thinking block-binding controls are unconfirmed on Foundry, and sending
   * the field where the beta is not taken is a 400 on every request. Without
   * it, a thinking block invalidated by an edit to the history is handled by
   * stripping the blocks and asking once more (see `AnthropicProvider.send`).
   */
  protected override bindsThinking(): boolean {
    return false;
  }

  protected override endpoint(): ResponsesEndpoint {
    return messagesEndpoint(foundryTarget(this.config));
  }
}

/**
 * Its own class rather than a flag on `OpenAIProvider`: Azure names the
 * deployment rather than the model, pins an api-version, authenticates with an
 * `api-key` header or an Entra token, and puts the resource in the host. One
 * class carrying both shapes means every field is conditionally meaningful.
 *
 * (It used to put the deployment in the URL as well. It does not: the Responses
 * API serves no such path — see `azureBase` for the measurements.)
 *
 * The API stays symmetrical — `.model()`, not `.deployment()`. Apps name a
 * model; mapping that onto a deployment is this class's problem, and an app
 * that named its deployment differently overrides it in config.
 */
export class AzureOpenAIProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  protected readonly config: AzureConfig;

  constructor(model: string, config: AzureConfig = {}) {
    super();
    this.model = model;
    // Read off the model, not the deployment: a deployment called `prod` says
    // nothing, and an unrecognized name lands on the all-capabilities default
    // anyway. See `capabilitiesForModel`.
    this.capabilities = capabilitiesForModel(model);
    this.config = config;
  }

  /** Defaults from gemi's config (`ai.azure`). */
  static model(model: string, config?: AzureConfig): AzureOpenAIProvider {
    return new AzureOpenAIProvider(model, config);
  }

  static models(): readonly string[] {
    return OPENAI_MODELS;
  }

  stream(params: ProviderStreamParams): ProviderStream {
    const body = buildResponsesRequest(params, {
      model: this.deployment(),
      capabilities: this.capabilities,
    });
    return streamResponses(this.endpoint(), body, {
      signal: params.signal,
      // The request carries the schema whenever the agent declared one, so the
      // parser has to read the answer as one too — a model that ignored the
      // parameter answers 400, not prose.
      structuredOutput: Boolean(params.output),
      files: sentFiles(params.messages),
    });
  }

  /** `assistants`, not OpenAI's `user_data`: Azure's Responses API refuses a
   *  `user_data` id outright (#682). See `UploadPurpose`. */
  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file, "assistants");
  }

  protected deployment(): string {
    return this.config.deployment ?? this.model;
  }

  protected endpoint(): ResponsesEndpoint {
    return responsesEndpoint(azureTarget(this.config));
  }

  /**
   * Realtime (voice) calls on this Azure resource, on its GA
   * `/openai/v1/realtime` surface whatever `apiVersion` says (see
   * `azureRealtimeTarget`). The deployment is the call's default model, as it
   * is a text call's.
   *
   * Calls use Azure's documented server-proxied flow by default: a client
   * secret minted with the resource's credential, then the raw SDP posted with
   * that secret (`callFlow: "ephemeral"`), all server-side. Pass
   * `createCall({ flow: "unified" })` to try the multipart shape instead.
   *
   * @experimental Not yet verified against a live Azure call.
   */
  get realtime(): RealtimeClient {
    return new RealtimeClient(
      azureRealtimeTarget(this.config, { timeoutMs: DEFAULT_REALTIME_TIMEOUT_MS }),
      { model: this.deployment(), callFlow: "ephemeral" },
    );
  }
}
