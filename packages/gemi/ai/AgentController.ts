// @ts-nocheck — the ai rfc is a sketch; see Schema.ts for the full note.
import type { HttpRequest } from "../http";
import type { Controller } from "../http/Controller";
import type { MiddlewareInput } from "../http/middlewareList";
import type { AgentRun, AgentRunResult, AnyAgent, ToolExecute, ToolShapesOf } from "./Agent";
import type { AgentError, AgentMessage, PendingToolCall, ToolShapes } from "./types";

// --- storage -------------------------------------------------------------

/**
 * Where conversations live.
 *
 * Stateless is the default and nothing here is required to hold a conversation:
 * the client can carry its own history, and a pending approval travels in it
 * safely because the server signed it. What a store buys is a conversation that
 * survives the browser — and, with `/attach`, one whose interrupted turn is
 * still there after a refresh.
 */
export interface AgentStore {
  createThread(params: { userId?: string | number }): Promise<{ threadId: string }>;
  loadThread(threadId: string): Promise<AgentMessage[]>;
  appendMessages(threadId: string, messages: AgentMessage[]): Promise<void>;
}

/** The default: conversations last as long as the process. */
export declare class MemoryAgentStore implements AgentStore {
  constructor(params?: { ttlMs?: number });
  createThread(params: { userId?: string | number }): Promise<{ threadId: string }>;
  loadThread(threadId: string): Promise<AgentMessage[]>;
  appendMessages(threadId: string, messages: AgentMessage[]): Promise<void>;
}

/**
 * The runs currently in flight, and their frames.
 *
 * A run outlives the request that started it, so something has to hold it while
 * no one is listening, and hold what it emitted meanwhile so a returning client
 * can catch up rather than start over. That is all this is: a per-process map
 * plus a bounded buffer.
 *
 * Per-process is not an implementation shortcut that a better store fixes — a
 * running generator lives in one process, and a second server cannot attach to
 * it. Reattachment therefore needs the request to land where the run is: one
 * server, sticky routing, or a proxy that forwards by `runId`. Worth saying out
 * loud, because the failure mode behind a round-robin load balancer is a
 * refresh that usually works.
 */
export interface LiveRuns {
  /** What the client asks after a refresh: is anything still going here? */
  find(params: { threadId: string }): Promise<{ runId: string; seq: number } | null>;
  get(runId: string): AgentRun | null;
  /** Kept for a short while after `run-end`, so a refresh a second late still
   *  sees the tail instead of an empty screen. */
  ttlMs: number;
}

// --- controller ----------------------------------------------------------

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

  /**
   * `POST /<path>` — one route for every client turn. A first message, an
   * approval, an answer to a question and a client tool's result are all just
   * the next turn, so none of them gets an endpoint of its own.
   */
  stream(req: HttpRequest<any, any>): Promise<Response>;
  /**
   * `POST /<path>/attach` — subscribe to a run already in progress, from a
   * cursor. This is a read of a live run, not a continuation of a stopped one:
   * the work never paused, the listener changed.
   */
  attach(req: HttpRequest<any, any>): Promise<Response>;
  /** `POST /<path>/stop` — the explicit cancel. Since a dropped connection no
   *  longer stops a run, this is the only thing that does. */
  stop(req: HttpRequest<any, any>): Promise<{ stopped: boolean }>;
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
  /** Fires before the stream ends `awaiting-input` — where to notify whoever
   *  has to approve, if they are not the person watching the stream. */
  protected onAwaitingInput(
    pending: PendingToolCall[],
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
//   POST /chat        → stream   every client turn
//   POST /chat/attach → attach   reattach to a run in progress
//   POST /chat/stop   → stop     explicit cancel
//   POST /chat/files  → upload   attachments
//
// Mounting under a single path is what gives the client one key to name. The
// agent's tool types ride along on `AgentRoute`, so `useChat("/chat")` gets them
// out of the existing `RPC` interface — no second augmentation to generate, and
// renaming the route moves the client key with it.

export type AgentRouteMethod = "stream" | "attach" | "stop" | "upload";

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
