/**
 * `gemi/ai` — the server half of the agent module.
 *
 * THIS ENTRY IS NOT IMPORTABLE FROM A BROWSER BUNDLE, AND THAT IS THE POINT.
 * `useChat` lives at `gemi/ai/client` instead. Two entries rather than one
 * because a barrel is a runtime dependency, not a menu: a component importing
 * `useChat` from here would evaluate this file, and this file reaches
 * `AgentProvider` (which holds the OpenAI and Azure clients and reads
 * `OPENAI_API_KEY` / `AZURE_OPENAI_API_KEY` out of the environment), `Agent`
 * (whose registry closes over every tool's `execute` — the app's server code,
 * with its database handles and its secrets in scope) and, through `Agent`,
 * `signing.ts`, which reads `process.env.SECRET` and is the one value whose
 * disclosure lets a client forge its own approvals.
 *
 * Tree-shaking is not a defence to rely on here. It is a bundler optimization
 * that a dev server, a test runner and a misconfigured build all skip, and the
 * failure is silent — the code ships and nobody looks. The import graph is the
 * defence: `ai/client/index.ts` cannot reach any of the above, because nothing
 * it imports does.
 *
 * The split is free rather than a compromise: `useChat` already depended on
 * none of this. It reads its transport off `RPC` and its state out of a
 * reducer over the wire frames, so the server types it needs (`AgentMessage`,
 * `PendingToolCall`) come from `ai/types.ts`, which imports nothing at all.
 */

// --- schema ---------------------------------------------------------------
//
// `s` is here rather than in both entries because a schema is a server
// declaration: it produces the JSON Schema the model is shown and parses what
// the model sends back, both of which happen beside the tool. The *types* it
// yields travel to the client on their own, through the route's `RPC` entry.
export { JSONSchemaError, s } from "./Schema";
// `ProviderStreamParams.output` requires `strict`, and this is the only correct
// way to answer it — the flag is a property of the schema, not a choice. A custom
// provider or a request harness has to build those params, so leaving the
// derivation internal would mean requiring an answer and withholding it.
export { supportsStrict } from "./Schema";
export type {
  AnySchema,
  FromJSONSchemaOptions,
  Infer,
  JSONSchemaFormat,
  JsonValue,
  JSONSchema,
  OptionalSchema,
  Schema,
  SchemaIssue,
  SchemaIssueCode,
} from "./Schema";

// --- the wire vocabulary --------------------------------------------------
//
// Also re-exported from `gemi/ai/client`. They are types, so both copies erase.
export type {
  AgentContentPart,
  AgentError,
  AgentErrorCode,
  AgentMessage,
  AgentStreamEvent,
  AgentStreamFrame,
  ClientToolResult,
  ClientTurn,
  FilePart,
  FinishReason,
  NestedRun,
  OutputPart,
  PendingToolCall,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolSearchRecord,
  ToolShape,
  ToolShapes,
  Usage,
} from "./types";

// --- agents, tools and skills ---------------------------------------------
export {
  Agent,
  AgentTool,
  // A class, and exported as a value on purpose: a tool that wants to let a
  // sub-agent's question through untouched needs `instanceof` to tell an
  // escalation from a failure, and rethrowing everything is not the same thing.
  PendingEscalation,
  // A class for the same reason: `result({ throwOnError: true })` rejects with
  // it, and a caller tells a failed run from its own bug with `instanceof`.
  AgentRunError,
  // What `maxRunDurationMs` is when an agent does not set it, so an app can
  // derive its own limits from it rather than restate ten minutes.
  DEFAULT_MAX_RUN_DURATION_MS,
  Skill,
  SKILLS_NAMESPACE,
  ToolNamespace,
} from "./Agent";
export type {
  AgentContext,
  AgentResultOptions,
  AgentRun,
  AgentRunFailure,
  AgentRunResult,
  AgentStreamParams,
  AnyAgent,
  AnyAgentTool,
  CreateAgentParams,
  NestedRunResult,
  OutputOf,
  PrepareStep,
  PrepareStepContext,
  PrepareStepResult,
  ReasoningEffort,
  RunAgentParams,
  SkillDefinition,
  ToolContext,
  ToolDefinition,
  ToolEntry,
  ToolExecute,
  ToolInputSchema,
  ToolSchemaContext,
  ToolShapesOf,
  ToolTurn,
} from "./Agent";

// --- the context window (#473) --------------------------------------------
//
// Turn boundaries and the built-in window policy, for `contextWindow` and for
// a `prepareStep` that bounds the request itself.
export {
  DEFAULT_CONTEXT_WINDOW_NOTE,
  DEFAULT_CONTEXT_WINDOW_STEP,
  injectedMessageIds,
  messageSize,
  splitTurns,
  turnStarts,
  windowMessages,
} from "./contextWindow";
export type { ContextWindowOptions, ContextWindowResult } from "./contextWindow";
// Compaction: summarising the turns the window leaves out (#782).
export {
  COMPACT_SUMMARY_HEADER,
  DEFAULT_COMPACT_INSTRUCTIONS,
  DEFAULT_MAX_SUMMARY_TOKENS,
  defaultSummaryStore,
  keepSummary,
  MemorySummaryStore,
} from "./contextCompaction";
export type { ContextCompactOptions, SummaryStore, ThreadSummary } from "./contextCompaction";

// --- what a client is told about a failure (#446) --------------------------
//
// `ToolError` is a class, exported as a value: a tool throws it when its
// message is written to be read, and every other exception reaches the model
// and the client as a generic sentence. `redactError` is the default, for an
// app's override of `AgentController.redactError` to fall back to.
export { redactError, ToolError } from "./redact";
export type { ErrorRedactionInfo, ErrorRedactor } from "./redact";

// --- one model call --------------------------------------------------------
//
// A typed answer with no tool loop. Inside a tool, `ctx.generate` is the same
// function bound to the turn — see `ToolContext.generate`.
export { generate } from "./generate";
export type { GenerateParams, GenerateResult, GenerateSuccess } from "./generate";

// --- an app's API routes as tools ------------------------------------------
//
// The registry itself is `McpRegistry` in `gemi/services`; this is its one v1
// projection, here because an agent's tools are declared beside the agent.
export {
  toAgentTools,
  type McpAgentTool,
  type McpToolShapesOf,
  type McpToolNamespaceOptions,
  type ToAgentToolsOptions,
} from "../services/mcp/toAgentTools";

// --- images ---------------------------------------------------------------
//
// A separate provider hierarchy from the agent one, deliberately: an image
// deployment has no `stream()` and `capabilitiesForModel` would grant an
// unrecognised id every text capability it does not have. See `ImageProvider`.
export { ImageModel } from "./ImageModel";
export type {
  CreateImageModelParams,
  EditImageParams,
  GeneratedImage,
  GenerateImageParams,
  ImageBackground,
  ImageFormat,
  ImageInput,
  ImageQuality,
  ImageSize,
} from "./ImageModel";
export { AzureOpenAIImageProvider, ImageProvider, OpenAIImageProvider } from "./ImageProvider";
export type { ImageProviderEditParams, ImageProviderParams } from "./ImageProvider";
// The failure an app branches on. `code` is the same normalized
// `AgentErrorCode` a text call reports, so `rate_limited` means one thing.
export { ImageRequestError } from "./providers/images";

// --- providers ------------------------------------------------------------
export { AgentProvider, AzureOpenAIProvider, OpenAIProvider } from "./AgentProvider";
export { evalChain, FallbackProvider } from "./FallbackProvider";
export type {
  EvalChainResult,
  FallbackCircuit,
  FallbackCircuitChange,
  FallbackEntry,
  FallbackFailure,
  FallbackOptions,
  FallbackUsage,
} from "./FallbackProvider";
export { MemoryCircuitStore } from "./CircuitStore";
export type { CircuitOutcome, CircuitPolicy, CircuitState, CircuitStore } from "./CircuitStore";
export type {
  AzureConfig,
  ProviderCapabilities,
  ProviderConfig,
  ProviderEvent,
  ProviderStream,
  ProviderStreamParams,
  ProviderToolNamespace,
  ProviderToolSpec,
} from "./AgentProvider";

// --- the controller, its stores and the route it mounts -------------------
export {
  AgentController,
  AttachmentNotFoundError,
  defaultAgentStore,
  defaultAttachmentStore,
  defaultFileOwners,
  defaultNonceStore,
  FrameCursorEvictedError,
  InvalidAttachmentScopeError,
  liveRuns,
  LiveRunNotFoundError,
  MemoryAgentStore,
  MemoryAttachmentStore,
  MemoryFileOwners,
  MemoryLiveRuns,
  MemoryNonceStore,
  MemoryReceiptStore,
  RedisNonceStore,
  RedisReceiptStore,
  ScopedAttachments,
} from "./AgentController";
export type {
  AgentHookContext,
  AgentMiddlewareConfig,
  AgentRoute,
  AgentRouteMethod,
  AgentRouteRPC,
  AgentStore,
  Attachment,
  AttachmentDestination,
  AttachmentLimits,
  AttachmentScope,
  AttachmentStorage,
  AttachmentStore,
  AuthorizeRequestParams,
  FileOwnerRecord,
  FileOwners,
  LiveRuns,
  NonceRedisClient,
  NonceStore,
  PutAttachmentParams,
  ReceiptClaim,
  ReceiptRedisClient,
  ReceiptStore,
  RedisNonceStoreOptions,
  RedisReceiptStoreOptions,
  ToolAttachmentPut,
  ToolAttachmentRecord,
  ToolAttachments,
  UploadResult,
} from "./AgentController";

// Deliberately NOT exported: `./signing`. An approval's signature is machinery
// the RFC promises an app never sees — `useChat` hands the token back untouched
// and the app answers with a boolean. Exporting `signPendingCall` would offer a
// second way to mint one, which is the one thing that must have a single
// author; exporting `verifyPendingCall` would invite a check that skips
// `consumePendingCall`, i.e. a verification that permits replay. It stays an
// internal import of `Agent.ts`.
