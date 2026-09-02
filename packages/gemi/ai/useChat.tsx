// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { RPC } from "../client/rpc";
import type { AgentError, AgentMessage, ToolShapes, UserMessageInput } from "./types";

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
 * What the UI is waiting on. `awaiting-approval` is its own state rather than a
 * flavour of idle: the run is alive but parked, and the only thing that moves it
 * is a human, so a UI that cannot distinguish it will either look hung or look
 * finished.
 */
export type ChatStatus = "idle" | "submitted" | "streaming" | "awaiting-approval" | "error";

export type PendingApproval<T extends ToolShapes> = {
  [K in keyof T]: { toolCallId: string; name: K; input: T[K]["input"] };
}[keyof T];

export interface UseChatParams<P extends keyof AgentRoutes> {
  /** Continues a server-side thread. Omitted, the hook keeps history itself and
   *  sends it with each request — the stateless default. */
  threadId?: string;
  /** Server-rendered or restored history. */
  initialMessages?: AgentMessage<ToolsOf<P>, OutputOf<P>>[];
  /** Merged into the request body, for anything the agent's controller reads
   *  off the request that is not a message. */
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  onFinish?: (message: AgentMessage<ToolsOf<P>, OutputOf<P>>) => void;
  onError?: (error: AgentError) => void;
  onApprovalRequired?: (pending: PendingApproval<ToolsOf<P>>[]) => void;
}

export interface UseChatResult<P extends keyof AgentRoutes> {
  messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[];
  status: ChatStatus;
  /** Cleared by the next successful send, so a retry does not have to clear it. */
  error: AgentError | null;
  /** Set once the server has assigned one. */
  threadId?: string;

  sendMessage(input: UserMessageInput | string): Promise<void>;
  /** Aborts the fetch; the server sees the disconnect and aborts the run with
   *  it, so a stopped generation stops being billed. */
  stop(): void;
  /** Drops the last assistant turn and re-runs from the user turn before it. */
  regenerate(): Promise<void>;
  setMessages(messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[]): void;

  /** Non-empty exactly when `status === "awaiting-approval"`. */
  pendingApprovals: PendingApproval<ToolsOf<P>>[];
  /** Answers every pending approval and resumes the run on a fresh stream.
   *  Partial answers are allowed: anything not named is treated as denied. */
  respond(
    decisions: Record<string, boolean | { approve: boolean; reason?: string }>,
  ): Promise<void>;

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
