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
export { s } from "./Schema";
export type { AnySchema, Infer, JSONSchema, OptionalSchema, Schema } from "./Schema";

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
  OutputPart,
  PendingToolCall,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ToolShape,
  ToolShapes,
  Usage,
} from "./types";

// --- agents, tools and skills ---------------------------------------------
export { Agent, AgentTool, Skill, SKILLS_NAMESPACE, ToolNamespace } from "./Agent";
export type {
  AgentRun,
  AgentRunResult,
  AgentStreamParams,
  AnyAgent,
  AnyAgentTool,
  CreateAgentParams,
  OutputOf,
  ReasoningEffort,
  SkillDefinition,
  ToolContext,
  ToolDefinition,
  ToolEntry,
  ToolExecute,
  ToolShapesOf,
} from "./Agent";

// --- providers ------------------------------------------------------------
export { AgentProvider, AzureOpenAIProvider, OpenAIProvider } from "./AgentProvider";
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
  defaultAgentStore,
  FrameCursorEvictedError,
  liveRuns,
  LiveRunNotFoundError,
  MemoryAgentStore,
  MemoryLiveRuns,
} from "./AgentController";
export type {
  AgentHookContext,
  AgentMiddlewareConfig,
  AgentRoute,
  AgentRouteMethod,
  AgentRouteRPC,
  AgentStore,
  LiveRuns,
} from "./AgentController";

// Deliberately NOT exported: `./signing`. An approval's signature is machinery
// the RFC promises an app never sees — `useChat` hands the token back untouched
// and the app answers with a boolean. Exporting `signPendingCall` would offer a
// second way to mint one, which is the one thing that must have a single
// author; exporting `verifyPendingCall` would invite a check that skips
// `consumePendingCall`, i.e. a verification that permits replay. It stays an
// internal import of `Agent.ts`.
