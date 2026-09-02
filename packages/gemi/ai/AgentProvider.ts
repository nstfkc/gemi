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
  | { type: "tool-call-delta"; toolCallId: string; name: string; argsDelta: string }
  | { type: "tool-call"; toolCallId: string; name: string; args: string }
  /** The model went looking for a deferred tool and pulled its schema in. Worth
   *  surfacing rather than swallowing: it is a step the user paid for, and the
   *  pause before it is otherwise unexplained. */
  | { type: "tool-search"; loaded: string[] }
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

const OPENAI_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
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
      structuredOutput: Boolean(params.output) && this.capabilities.structuredOutput,
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
  /** `https://<resource>.openai.azure.com`. */
  endpoint?: string;
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
 * The api-version is pinned rather than defaulted to "latest", because Azure
 * treats a version as a contract and a floating one turns a Tuesday morning
 * into a debugging session. An app that needs a newer one names it.
 */
const AZURE_API_VERSION = "2025-04-01-preview";

/**
 * Its own class rather than a flag on `OpenAIProvider`: Azure puts the
 * deployment in the URL, pins an api-version, and has a second auth mode. One
 * class carrying both shapes means every field is conditionally meaningful.
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
      structuredOutput: Boolean(params.output) && this.capabilities.structuredOutput,
    });
  }

  upload(file: File): Promise<string> {
    return uploadFile(this.endpoint(), file);
  }

  protected deployment(): string {
    return this.config.deployment ?? this.model;
  }

  protected endpoint(): ResponsesEndpoint {
    const config = this.config;
    const host = (config.baseURL ?? config.endpoint ?? env("AZURE_OPENAI_ENDPOINT") ?? "").replace(
      /\/+$/,
      "",
    );
    const apiVersion = config.apiVersion ?? env("AZURE_OPENAI_API_VERSION") ?? AZURE_API_VERSION;
    const query = `?api-version=${encodeURIComponent(apiVersion)}`;
    return {
      responsesUrl: `${host}/openai/deployments/${encodeURIComponent(
        this.deployment(),
      )}/responses${query}`,
      // Files are resource-scoped, not deployment-scoped: an upload is not
      // addressed to a model.
      filesUrl: `${host}/openai/files${query}`,
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
