// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { RPC } from "../client/rpc";
import type { AgentError, AgentMessage, ClientTurn, PendingToolCall, ToolShapes } from "./types";

/**
 * The agent routes, picked out of the same `RPC` interface `useQuery` and
 * `useMutation` read. An agent is not a second kind of thing to register — it is
 * a route, so its key is its path and its types arrive the way every other
 * route's types do.
 */
type AgentRoutes = {
  [K in keyof RPC as RPC[K] extends { __agent: true } ? K : never]: RPC[K];
};

type ToolsOf<P extends keyof AgentRoutes> = AgentRoutes[P] extends { tools: infer T }
  ? T extends ToolShapes
    ? T
    : ToolShapes
  : ToolShapes;

type OutputOf<P extends keyof AgentRoutes> = AgentRoutes[P] extends { output: infer O }
  ? O
  : unknown;

/**
 * What the UI is waiting on.
 *
 * `awaiting-input` is its own state rather than a flavour of idle: the run is
 * over, but the conversation is holding a question, and a UI that cannot tell
 * the difference will either look hung or look finished.
 */
export type ChatStatus = "idle" | "submitted" | "streaming" | "awaiting-input" | "error";

export interface UseChatParams<P extends keyof AgentRoutes> {
  /** Continues a server-side thread. Omitted, the hook keeps history itself and
   *  sends it with each request — the stateless default. */
  threadId?: string;
  /** Server-rendered or restored history. */
  initialMessages?: AgentMessage<ToolsOf<P>, OutputOf<P>>[];
  /**
   * On mount, ask whether a run is still going on this thread and pick it back
   * up from where this client left off. Needs a `threadId` — that is the handle
   * that survives a refresh, which is why the client is never asked to stash a
   * `runId` of its own. Defaults to true.
   */
  attach?: boolean;
  /** Merged into the request body, for anything the agent's controller reads
   *  off the request that is not a message. */
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  onFinish?: (message: AgentMessage<ToolsOf<P>, OutputOf<P>>) => void;
  onError?: (error: AgentError) => void;
  onAwaitingInput?: (pending: PendingToolCall<ToolsOf<P>>[]) => void;
}

export interface UseChatResult<P extends keyof AgentRoutes> {
  messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[];
  status: ChatStatus;
  /** Cleared by the next successful send, so a retry does not have to clear it. */
  error: AgentError | null;
  /** Set once the server has assigned one. */
  threadId?: string;
  /** The run being streamed or attached to, if any. */
  runId?: string;

  /**
   * The one way to advance the conversation. A string is shorthand for
   * `{ text }`; answers to pending calls go in the same turn, and may travel
   * with text.
   */
  sendMessage(turn: ClientTurn | string): Promise<void>;
  /** Explicit cancel — a closed tab no longer stops a run, so this is what
   *  does. */
  stop(): Promise<void>;
  /** Drops the last assistant turn and re-runs from the user turn before it. */
  regenerate(): Promise<void>;
  setMessages(messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[]): void;

  /** Non-empty exactly when `status === "awaiting-input"`. */
  pending: PendingToolCall<ToolsOf<P>>[];
  /**
   * Sugar over `sendMessage`. The hook carries each pending call's signature and
   * hands it back untouched, so an app answers with a boolean and never sees the
   * mechanism that makes answering trustworthy.
   */
  approve(toolCallId: string, approve: boolean, reason?: string): Promise<void>;
  /** The same, for a `question` or `client` tool: the value is checked against
   *  the tool's output schema server-side before the model sees it. */
  answer(toolCallId: string, output: unknown): Promise<void>;

  /** Uploads through the agent's own upload route and returns the id to put in
   *  `sendMessage({ files })`. Here rather than in app code because the route is
   *  derived from the same path. */
  attach(file: File): Promise<{ fileId: string; name: string; mimeType: string }>;
}

/**
 * The path is the agent's route, exactly as mounted:
 *
 *   const { messages, sendMessage } = useChat("/chat")
 *
 * and a tool part inside `messages` narrows on `name`, giving `input` and
 * `output` their real types — which is the whole reason the tool tuple is
 * carried through `Agent`, `AgentRoute` and `RPC` instead of being erased at the
 * first boundary.
 */
export declare function useChat<P extends keyof AgentRoutes>(
  path: P,
  params?: UseChatParams<P>,
): UseChatResult<P>;
