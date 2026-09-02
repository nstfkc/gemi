// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { ReasoningEffort } from "./Agent";
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

export declare abstract class AgentProvider {
  abstract readonly model: string;
  abstract readonly capabilities: ProviderCapabilities;

  /** The model ids this provider knows about — for autocomplete only; any
   *  string is still accepted, because a new model must not require a gemi
   *  release to use. */
  static models(): readonly string[];

  abstract stream(params: ProviderStreamParams): ProviderStream;

  /**
   * Uploads a file and returns the id a `FilePart` carries. Message history
   * therefore holds provider file ids, which is the trade for getting vision
   * and PDF input without gemi owning a storage story in v1.
   */
  abstract upload(file: File): Promise<string>;

  /** Maps a provider's error body onto the normalized codes, so an app can
   *  branch on `rate_limited` without knowing whose rate limit it was. */
  abstract normalizeError(error: unknown): AgentError;
}

export declare class OpenAIProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  /** Config defaults come from gemi's config (`ai.openai`), so an app that has
   *  set `OPENAI_API_KEY` writes only the model name. */
  static model(model: string, config?: ProviderConfig): OpenAIProvider;
  static models(): readonly string[];

  stream(params: ProviderStreamParams): ProviderStream;
  upload(file: File): Promise<string>;
  normalizeError(error: unknown): AgentError;
}

export type AzureConfig = ProviderConfig & {
  /** `https://<resource>.openai.azure.com`. */
  endpoint?: string;
  apiVersion?: string;
  /**
   * For Entra ID instead of a key. A function, not a token, because these
   * expire mid-conversation.
   */
  getToken?: () => Promise<string>;
};

/**
 * Its own class rather than a flag on `OpenAIProvider`: Azure puts the
 * deployment in the URL, pins an api-version, and has a second auth mode. One
 * class carrying both shapes means every field is conditionally meaningful.
 *
 * The API stays symmetrical — `.model()`, not `.deployment()`. Apps name a
 * model; mapping that onto a deployment is this class's problem, and an app
 * that named its deployment differently overrides it in config.
 */
export declare class AzureOpenAIProvider extends AgentProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  /** Defaults from gemi's config (`ai.azure`). */
  static model(model: string, config?: AzureConfig): AzureOpenAIProvider;
  static models(): readonly string[];

  stream(params: ProviderStreamParams): ProviderStream;
  upload(file: File): Promise<string>;
  normalizeError(error: unknown): AgentError;
}
