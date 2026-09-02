import type { ReasoningEffort } from "./Agent";
import { streamResponses, uploadFile, type ResponsesEndpoint } from "./providers/call";
import { capabilitiesForModel } from "./providers/capabilities";
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
   *  whatever its own strict-JSON parameter is. */
  output?: { name: string; schema: JSONSchema };
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
  | { type: "error"; error: AgentError };

export type ProviderStream = AsyncIterable<ProviderEvent>;

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
};


/** Long enough for a reasoning model to think before it says anything, short
 *  enough that a hung connection is not mistaken for a slow one. Only covers
 *  getting a response; the stream that follows has no deadline. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

function env(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.[name];
}

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

  protected baseURL(): string {
    return (this.config.baseURL ?? env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
  }

  protected endpoint(): ResponsesEndpoint {
    const base = this.baseURL();
    const config = this.config;
    return {
      responsesUrl: `${base}/responses`,
      filesUrl: `${base}/files`,
      headers: async () => {
        const apiKey = config.apiKey ?? env("OPENAI_API_KEY");
        return {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...config.headers,
        };
      },
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }
}

export type AzureConfig = ProviderConfig & {
  /**
   * The resource host, with or without a trailing `/openai`. Both spellings
   * work — `https://<resource>.cognitiveservices.azure.com` and
   * `https://<resource>.openai.azure.com` — and neither is rewritten, because
   * only one of them exists for a resource that was not created as
   * kind=OpenAI. See `azureBase` for what is done to it.
   */
  endpoint?: string;
  /**
   * Just the resource name, when there is no endpoint to hand. `<name>` is
   * expanded to `https://<name>.cognitiveservices.azure.com/openai`.
   */
  resourceName?: string;
  apiVersion?: string;
  /**
   * The deployment to call, when it is not named after the model. Azure lets
   * whoever ran the template call it anything, and plenty of them are called
   * `prod` — this is the override the class comment promises.
   */
  deployment?: string;
  /**
   * For Entra ID instead of a key. A function, not a token, because these
   * expire mid-conversation.
   */
  getToken?: () => Promise<string>;
};

/**
 * `preview` selects Azure's `/openai/v1` surface, which is the OpenAI-shaped
 * one — same request body, same SSE frames, same `model` field naming the
 * deployment — and it is the only surface the Responses API has that gemi's
 * request builder can talk to unchanged. It takes no dated version: sending
 * `api-version=2025-04-01-preview` to `/openai/v1/responses` answers
 * `400 {"code":"BadRequest","message":"API version not supported"}`.
 *
 * A dated version is still honoured, and routes to the older
 * `/openai/responses` path instead — see `azurePath`. So an app that pinned
 * one keeps working, which is the promise the old comment here made and could
 * not keep once the paths diverged.
 */
const AZURE_API_VERSION = "preview";

/**
 * Where an Azure Responses call goes, worked out live rather than from docs.
 *
 * THE PROBLEM THIS SOLVES. `AZURE_OPENAI_ENDPOINT` is conventionally written
 * with `/openai` already on the end, and the old code appended `/openai` again
 * and then a deployment path, producing
 * `…/openai/openai/deployments/<dep>/responses` — a 404 on every request, for
 * every app that configured the provider the documented way. Two separate
 * mistakes were stacked there, and only measuring told them apart.
 *
 * WHAT WAS MEASURED, against a real resource, POSTing a Responses body:
 *
 *   404  {endpoint}/openai/deployments/gpt-5.4/responses?api-version=2025-04-01-preview
 *   404  {host}/openai/deployments/gpt-5.4/responses?api-version=2025-04-01-preview
 *   404  {host}/openai/deployments/gpt-5.4/responses?api-version=preview
 *   400  {host}/openai/v1/responses?api-version=2025-04-01-preview   ("API version not supported")
 *   200  {host}/openai/v1/responses?api-version=preview
 *   200  {host}/openai/v1/responses                                   (no api-version at all)
 *   200  {host}/openai/responses?api-version=2025-04-01-preview
 *
 * for {host} in BOTH `https://<resource>.cognitiveservices.azure.com` and
 * `https://<resource>.openai.azure.com` — both spellings answered identically,
 * so the host was never the variable. The deployment-in-the-URL path is the
 * Chat Completions shape and the Responses API does not serve it at all; the
 * deployment goes in the body's `model`, which is what `buildResponsesRequest`
 * already puts there.
 *
 * `/openai/v1/files?api-version=preview` and
 * `/openai/files?api-version=2025-04-01-preview` were both checked too (200,
 * empty list), so uploads follow the same fork.
 */
function azureBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  // A configured endpoint may or may not already carry `/openai`, and may even
  // carry `/openai/v1` if someone copied a full URL. Normalize down to the
  // resource base and put exactly one `/openai` back, rather than appending
  // blind — appending blind is the bug.
  const base = trimmed.replace(/\/openai(?:\/v1)?$/i, "");
  return `${base}/openai`;
}

/** Dated versions belong to the older path; `preview` (and anything that is not
 *  a date) belongs to `/v1`. Both were verified above. */
function azurePath(apiVersion: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(apiVersion) ? "" : "/v1";
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

  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file);
  }

  protected deployment(): string {
    return this.config.deployment ?? this.model;
  }

  /**
   * The resource base, `<host>/openai`, from whichever of the three ways it was
   * configured. A bare resource name expands to the `cognitiveservices` host
   * rather than the `openai.azure.com` one: both answer for a resource created
   * as kind=OpenAI, only `cognitiveservices` answers for an AI Foundry or
   * multi-service resource, so it is the spelling that is right more often. An
   * app on the other one sets `endpoint` and nothing rewrites it.
   */
  protected base(): string {
    const config = this.config;
    const configured = config.baseURL ?? config.endpoint ?? env("AZURE_OPENAI_ENDPOINT");
    if (configured) return azureBase(configured);
    const resource =
      config.resourceName ?? env("AZURE_OPENAI_RESOURCE_NAME") ?? env("AZURE_RESOURCE_NAME");
    return resource ? azureBase(`https://${resource.trim()}.cognitiveservices.azure.com`) : "";
  }

  protected endpoint(): ResponsesEndpoint {
    const config = this.config;
    const base = this.base();
    const apiVersion = config.apiVersion ?? env("AZURE_OPENAI_API_VERSION") ?? AZURE_API_VERSION;
    const path = azurePath(apiVersion);
    const query = `?api-version=${encodeURIComponent(apiVersion)}`;
    return {
      // No deployment in the URL: the Responses API does not serve that path,
      // and `buildResponsesRequest` already sends the deployment as `model`.
      responsesUrl: `${base}${path}/responses${query}`,
      // Files are resource-scoped, not deployment-scoped: an upload is not
      // addressed to a model.
      filesUrl: `${base}${path}/files${query}`,
      headers: async () => {
        // Called per request, not per provider: an Entra token minted when the
        // app booted is expired by the time a long conversation reaches step
        // nine, and that failure looks like a random 401 in the middle of a
        // working feature.
        if (config.getToken) {
          return { authorization: `Bearer ${await config.getToken()}`, ...config.headers };
        }
        const apiKey = config.apiKey ?? env("AZURE_OPENAI_API_KEY");
        return { ...(apiKey ? { "api-key": apiKey } : {}), ...config.headers };
      },
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }
}
