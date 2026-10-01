import type { ReasoningEffort } from "./Agent";
import {
  responsesEndpoint,
  streamResponses,
  uploadFile,
  type ResponsesEndpoint,
} from "./providers/call";
import { capabilitiesForModel } from "./providers/capabilities";
import {
  azureTarget,
  openAITarget,
  type AzureConfig,
  type ProviderConfig,
} from "./providers/endpoints";
import { normalizeProviderError } from "./providers/errors";
import { buildResponsesRequest } from "./providers/request";
import type { JSONSchema } from "./Schema";
import type { AgentError, AgentMessage, FinishReason, Usage } from "./types";

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

export interface ProviderStreamParams {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: (ProviderToolSpec | ProviderToolNamespace)[];
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
  | { type: "reasoning-delta"; delta: string; id?: string }
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
  | { type: "tool-search"; loaded: string[]; namespaces: string[] }
  | { type: "output-delta"; delta: string }
  | { type: "finish"; reason: FinishReason; usage: Usage }
  /**
   * `status` and `requestId` describe the HTTP response the error came from,
   * when there was one. They are for the server's record of the run
   * (`AgentRunResult.error`) and are never written to a client frame; leave
   * them out for an error that was not a response.
   */
  | { type: "error"; error: AgentError; status?: number; requestId?: string };

export type ProviderStream = AsyncIterable<ProviderEvent>;

/**
 * Re-exported rather than declared here. What these configure is the *vendor*,
 * not the Responses API, and the images path resolves the same host, credential
 * and api-version from the same fields — see `providers/endpoints.ts` for why
 * that resolution lives in one place and what happens when it does not.
 */
export type { AzureConfig, ProviderConfig } from "./providers/endpoints";

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
    });
  }

  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file);
  }

  protected endpoint(): ResponsesEndpoint {
    return responsesEndpoint(openAITarget(this.config));
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
}
