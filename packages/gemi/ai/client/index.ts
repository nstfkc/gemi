/**
 * `gemi/ai/client` — the browser half of the agent module.
 *
 * Separate from `gemi/ai` because that entry reaches the providers, the tool
 * registry and `signing.ts`; the long form of the argument is at the top of
 * `ai/index.ts`. The short form: a barrel is evaluated, not browsed, so the
 * only reliable way to keep an API key and a tool's `execute` out of a client
 * bundle is for the module the client imports to have no path to them.
 *
 * It does not, and nothing here is a compromise to keep it that way. Following
 * every import from this file reaches `useChat.tsx`, the SSE decoder, the frame
 * reducer, `ai/types.ts` (which imports nothing) and React. The agent's tool
 * types still arrive fully typed, because they travel as *types* on the route's
 * `RPC` entry rather than as a value this file would have to import.
 *
 * The sibling modules in this directory — `reducer.ts` and `sse.ts` — are
 * `useChat`'s internals and stay unexported. They are pure functions over
 * frames, which is why they are separately testable, but an app that reaches
 * for `applyFrame` is reimplementing the hook.
 */

export { useChat } from "../useChat";
export type {
  AgentAttachBody,
  AgentRequestBody,
  AgentStopBody,
  ChatStatus,
  UseChatParams,
  UseChatResult,
} from "../useChat";

// The vocabulary a chat UI renders, re-exported so a component needs one
// import. All types, so this costs nothing at runtime — and it is the same
// `ai/types.ts` the server reads, which is what stops the two halves drifting
// into two spellings of a message.
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
} from "../types";
