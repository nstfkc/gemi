// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { Controller } from "../http/Controller";
import type { HttpRequest } from "../http";
import type { MiddlewareInput } from "../http/middlewareList";
import type { AgentRun, AgentRunResult, AnyAgent, ToolExecute, ToolShapesOf } from "./Agent";
import type { AgentError, AgentMessage, ToolShapes } from "./types";

// --- storage -------------------------------------------------------------

/**
 * A run parked on an approval. It has to survive between two HTTP requests, so
 * it holds everything needed to pick the loop back up: which tools were asked
 * about, and the messages produced up to that point.
 */
export type ParkedRun = {
  runId: string;
  threadId?: string;
  agent: string;
  messages: AgentMessage[];
  pending: { toolCallId: string; name: string; input: unknown }[];
  createdAt: string;
  expiresAt: string;
};

/**
 * Where conversations and parked runs live.
 *
 * Stateless is the default, so nothing here is required to send a message: an
 * app that never uses approvals and lets the client hold history can ignore
 * this entirely. The moment a tool sets `requiresApproval`, though, a run has to
 * be recoverable by a *second* request — and the in-memory default only
 * recovers it in the same process. That is fine in dev and wrong behind more
 * than one server, so an app using approvals is expected to supply a real store.
 */
export interface AgentStore {
  createThread(params: { userId?: string | number }): Promise<{ threadId: string }>;
  loadThread(threadId: string): Promise<AgentMessage[]>;
  appendMessages(threadId: string, messages: AgentMessage[]): Promise<void>;

  saveRun(run: ParkedRun): Promise<void>;
  loadRun(runId: string): Promise<ParkedRun | null>;
  deleteRun(runId: string): Promise<void>;
}

/** The default. Single-process only — see the note on `AgentStore`. */
export declare class MemoryAgentStore implements AgentStore {
  constructor(params?: { ttlMs?: number });
  createThread(params: { userId?: string | number }): Promise<{ threadId: string }>;
  loadThread(threadId: string): Promise<AgentMessage[]>;
  appendMessages(threadId: string, messages: AgentMessage[]): Promise<void>;
  saveRun(run: ParkedRun): Promise<void>;
  loadRun(runId: string): Promise<ParkedRun | null>;
  deleteRun(runId: string): Promise<void>;
}

// --- controller ----------------------------------------------------------

/** Passed to every hook, so a subclass never has to thread state through
 *  itself. */
export type AgentHookContext = {
  req: HttpRequest<any, any>;
  runId: string;
  threadId?: string;
};

export declare abstract class AgentController<A extends AnyAgent = AnyAgent> extends Controller {
  static kind: "agent-controller";

  /** The agent this controller serves. A property rather than a constructor
   *  argument so `Router.agent(ChatController)` can take the class, matching how
   *  every other controller is mounted. */
  abstract agent: A;

  /** Defaults to `MemoryAgentStore`. */
  store: AgentStore;

  /**
   * Implementations for the agent's `deferred` tools. Typed against the agent's
   * declared tools, so a missing or misnamed one is a compile error rather than
   * a tool the model calls into nothing.
   */
  tools?: {
    [K in keyof ToolShapesOf<A["tools"]>]?: ToolExecute<
      ToolShapesOf<A["tools"]>[K]["input"],
      ToolShapesOf<A["tools"]>[K]["output"]
    >;
  };

  /** Appended to the agent's static instructions for this request — the user's
   *  name, tenant, today's date. */
  instructions(req: HttpRequest<any, any>): string | Promise<string> | void;

  /** `POST /<path>` — starts or continues a conversation. */
  stream(req: HttpRequest<any, any>): Promise<Response>;
  /** `POST /<path>/resume` — answers pending approvals and continues the run. */
  resume(req: HttpRequest<any, any>): Promise<Response>;
  /** `POST /<path>/files` — uploads an attachment and returns its file id. */
  upload(req: HttpRequest<any, any>): Promise<{ fileId: string }>;

  /**
   * Protected, not private: these exist to be overridden. `onMessage` fires for
   * every completed message, user and assistant alike, and is the intended
   * persistence point for an app that is not using `store`.
   */
  protected onMessage(message: AgentMessage, ctx: AgentHookContext): void | Promise<void>;
  protected onToolCall(
    call: { toolCallId: string; name: string; input: unknown },
    ctx: AgentHookContext,
  ): void | Promise<void>;
  /** Fires before the stream ends with `approval-required` — the place to send
   *  a notification to whoever has to approve. */
  protected onApprovalRequired(
    pending: ParkedRun["pending"],
    ctx: AgentHookContext,
  ): void | Promise<void>;
  protected onError(error: AgentError, ctx: AgentHookContext): void | Promise<void>;
  protected onStreamComplete(
    result: AgentRunResult<ToolShapesOf<A["tools"]>, any>,
    ctx: AgentHookContext,
  ): void | Promise<void>;
}

// --- routing -------------------------------------------------------------
//
// `agent()` itself belongs on ApiRouter next to `resource()`, which is the
// method it works like: one call, several routes, all of them the controller's.
// The types are sketched here because they are the ai module's contract, not
// the router's.
//
//   class Api extends ApiRouter {
//     routes = {
//       "/chat": this.agent(ChatAgentController),
//     };
//   }
//
//   POST /chat        → stream
//   POST /chat/resume → resume
//   POST /chat/files  → upload
//
// Mounting under a single path is what gives the client one key to name. The
// agent's tool types ride along on `AgentRoute`, so `useChat("/chat")` gets them
// out of the existing `RPC` interface — no second augmentation to generate, and
// renaming the route moves the client key with it.

export type AgentRouteMethod = "stream" | "resume" | "upload";

export type AgentMiddlewareConfig = Partial<Record<AgentRouteMethod, MiddlewareInput>>;

export type AgentRoute<T extends new () => AgentController<any>> = {
  __internal_brand: "AgentRoute";
  controller: T;
  middleware(config: AgentMiddlewareConfig): AgentRoute<T>;
};

/** What `CreateRPC` should produce for an agent route: enough for the client to
 *  type its messages, and nothing that drags server code into the bundle. */
export type AgentRouteRPC<T extends new () => AgentController<any>> = {
  __agent: true;
  tools: InstanceType<T>["agent"] extends AnyAgent
    ? ToolShapesOf<InstanceType<T>["agent"]["tools"]>
    : ToolShapes;
  output: unknown;
};
