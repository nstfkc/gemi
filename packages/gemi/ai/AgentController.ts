import { Controller } from "../http/Controller";
import { HttpRequest } from "../http/HttpRequest";
import type { MiddlewareInput } from "../http/middlewareList";
import type { AgentRun, AgentRunResult, AnyAgent, ToolShapesOf } from "./Agent";
import {
  FrameCursorEvictedError,
  liveRuns as defaultLiveRuns,
  LiveRunNotFoundError,
  MemoryLiveRuns,
} from "./store/LiveRuns";
import { defaultAgentStore, MemoryAgentStore } from "./store/MemoryAgentStore";
import { sseResponse } from "./store/sse";
import type {
  AgentError,
  AgentMessage,
  AgentStreamEvent,
  ClientTurn,
  PendingToolCall,
  ToolShapes,
} from "./types";

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
export { defaultAgentStore, MemoryAgentStore };

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
 *
 * This is the read side, which is all `attach` and `stop` need. Registering a
 * run and replaying its buffer are on `MemoryLiveRuns`, the only implementation
 * there can be — see the note there for why a second one would not help.
 */
export interface LiveRuns {
  /** What the client asks after a refresh: is anything still going here? */
  find(params: { threadId: string }): Promise<{ runId: string; seq: number } | null>;
  get(runId: string): AgentRun | null;
  /** Kept for a short while after `run-end`, so a refresh a second late still
   *  sees the tail instead of an empty screen. */
  ttlMs: number;
}

export {
  FrameCursorEvictedError,
  LiveRunNotFoundError,
  MemoryLiveRuns,
  defaultLiveRuns as liveRuns,
};

// --- controller ----------------------------------------------------------

export type AgentHookContext = {
  req: HttpRequest<any, any>;
  runId: string;
  threadId?: string;
};

/**
 * `Controller.kind` is typed as the literal `"controller"`, so a subclass that
 * declares a `kind` of its own fails the static-side check (TS2417). Widening
 * it belongs in `http/Controller.ts`, which this slice does not own; erasing
 * the static side of the base here is the smaller change and costs nothing —
 * `Controller.kind` has no reader, in this package or out of it.
 */
const ControllerBase = Controller as new () => Controller;

export abstract class AgentController<A extends AnyAgent = AnyAgent> extends ControllerBase {
  static kind = "agent-controller" as const;

  /** The agent this controller serves. A property rather than a constructor
   *  argument so `Router.agent(ChatController)` can take the class, matching how
   *  every other controller is mounted. */
  abstract agent: A;

  /**
   * Defaults to the process-wide `MemoryAgentStore`.
   *
   * Whatever you put here, make it something that outlives the request: this
   * controller is constructed fresh for every call, so `store = new
   * MemoryAgentStore()` written here is an empty store on every turn and a
   * threaded conversation silently reads back nothing. Assign a module-level
   * instance, or a store whose state is somewhere else entirely.
   */
  store: AgentStore = defaultAgentStore;

  /**
   * Defaults to the process-wide map. Overridable so a test — or an app running
   * two agents that must not see each other's runs — can hold its own; not so
   * that it can be moved off the process, which is not a thing that can be
   * done. See `MemoryLiveRuns`.
   */
  liveRuns: MemoryLiveRuns = defaultLiveRuns;

  /** Appended to the agent's static instructions for this request — the user's
   *  name, tenant, today's date. */
  instructions(req: HttpRequest<any, any>): string | Promise<string> | void {
    void req;
  }

  /**
   * `POST /<path>` — one route for every client turn. A first message, an
   * approval, an answer to a question and a client tool's result are all just
   * the next turn, so none of them gets an endpoint of its own.
   */
  async stream(req: HttpRequest<any, any> = new HttpRequest()): Promise<Response> {
    const parsed = await readJsonBody(req);
    if (parsed.error) {
      // Before anything is registered or charged for. A run started off a body
      // we could not read would answer nothing, at the user's expense.
      return invalidRequest(parsed.error);
    }
    const body = parsed.body;
    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    const turn = toClientTurn(body);

    // The whole of the stateless/threaded difference, in one expression: with a
    // thread the server owns the history, without one the client carries it.
    // Nothing else below branches on it, which is why stateless keeps working
    // even for an app that never configures a store.
    //
    // The `threadId` is the client's, and nothing here checks that this caller
    // owns it — `AgentStore` cannot, since it holds no user. A `threadId` is
    // therefore a capability and has to be unguessable (`createThread` mints a
    // uuid) and, for anything that matters, checked: override `instructions()`
    // or a `store` that scopes by `req.user`. The framework's job is to make
    // sure the route is behind the router's middleware in the first place,
    // which `ApiRouter.agent()` now does.
    const messages = threadId
      ? await this.store.loadThread(threadId)
      : Array.isArray(body.messages)
        ? (body.messages as AgentMessage[])
        : [];

    const instructions = (await this.instructions(req)) || undefined;

    const run = this.agent.stream({
      messages,
      turn,
      req,
      threadId,
      instructions,
    }) as AgentRun;

    const ctx: AgentHookContext = { req, runId: run.runId, threadId };

    // Registered before the response is built: the run is now owned by the
    // process rather than by this request, which is the property `/attach`
    // depends on and the reason a dropped connection no longer cancels
    // anything.
    this.liveRuns.register(run, {
      threadId,
      // The client's handle on a run it started, which is the only one that
      // exists before `run-start` reaches it. See `RegisterParams`.
      clientRunId: typeof body.clientRunId === "string" ? body.clientRunId : undefined,
      onEvent: (event) => this.dispatchEvent(event, ctx),
      onInternalError: (err) => this.reportHookFailure(err),
    });

    void this.persistRun(run, ctx);

    return run.toResponse();
  }

  /**
   * `POST /<path>/attach` — subscribe to a run already in progress, from a
   * cursor. This is a read of a live run, not a continuation of a stopped one:
   * the work never paused, the listener changed.
   *
   * The cursor is `from`, else the client's `cursor`, else `Last-Event-ID`,
   * else the oldest frame still buffered — and it is honoured only for the run
   * the client's `runId` names. A cursor the buffer has dropped is a 410 naming
   * what survives; *no* cursor is the tail, because a page reattaching on mount
   * has no transcript to leave a hole in. See `resolveCursor`.
   */
  async attach(req: HttpRequest<any, any> = new HttpRequest()): Promise<Response> {
    const parsed = await readJsonBody(req);
    if (parsed.error) {
      return invalidRequest(parsed.error);
    }
    const body = parsed.body;
    const threadId =
      typeof body.threadId === "string" ? body.threadId : searchParam(req, "threadId");

    if (!threadId) {
      return jsonResponse(400, {
        code: "invalid_request",
        message: "attach needs a threadId: it is the handle that survives a refresh.",
      });
    }

    const live = await this.liveRuns.find({ threadId });
    if (!live) {
      // An explicit miss, not a 200 with an empty stream. See `MemoryLiveRuns`:
      // behind a round-robin load balancer this is the common case, and it has
      // to be visible as one.
      return jsonResponse(404, {
        code: "no_live_run",
        message: `No run in progress for thread ${threadId} in this process.`,
      });
    }

    // A cursor is only a number if you know which run it counts within: `seq`
    // restarts at zero in every run, so honouring a cursor from run_1 against a
    // live run_2 would skip that many frames off the head of a run this client
    // has seen nothing of. `runId` is the client saying which run its cursor
    // means; naming one that is not live forfeits the cursor and takes the
    // tail, which is as close to the start as the buffer can offer.
    //
    // Only a MISMATCH forfeits. An absent `runId` is not a wrong answer, it is
    // an older question: `from` and `Last-Event-ID` predate the pairing and
    // carry no run, and an `EventSource` reconnecting on its own will never
    // grow one. Those keep resuming exactly as before.
    const cursorRunId = typeof body.runId === "string" ? body.runId : undefined;
    const cursor = cursorRunId && cursorRunId !== live.runId ? undefined : resolveCursor(req, body);

    try {
      return sseResponse(this.liveRuns.replay(live.runId, cursor));
    } catch (err) {
      if (err instanceof FrameCursorEvictedError) {
        // 410 rather than 404: the run is there, the position is not. A client
        // that gets this reloads the thread instead of resuming into a hole.
        return jsonResponse(410, {
          code: err.code,
          message: err.message,
          oldestSeq: err.oldest,
        });
      }
      if (err instanceof LiveRunNotFoundError) {
        // Lost the race with eviction between `find` and `replay`.
        return jsonResponse(404, { code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /**
   * `POST /<path>/stop` — the explicit cancel. Since a dropped connection no
   * longer stops a run, this is the only thing that does, and it is why
   * stopping cannot be a client-side concern: the tool loop is here, and a
   * client that stops reading has not stopped step four from charging a card.
   *
   * Returns as soon as the run is aborted, not when it has finished unwinding.
   * The terminal events — the stopped tool results, the aborted message — go
   * out on the run's own stream, so whoever is watching it sees the ending,
   * and `onMessage` records it whether anyone is watching or not.
   *
   * Answers `{ stopped }` normally, and a `Response` only to reject a request
   * it could not read — the union is the 400, not a second success shape.
   */
  async stop(
    req: HttpRequest<any, any> = new HttpRequest(),
  ): Promise<{ stopped: boolean } | Response> {
    const parsed = await readJsonBody(req);
    if (parsed.error) {
      // `{ stopped: false }` would be the wrong answer as well as the wrong
      // status: it means "there was nothing to stop", and the truth is that we
      // could not tell what to stop. A client that believes the first one stops
      // asking, and the run keeps going.
      return invalidRequest(parsed.error);
    }
    const body = parsed.body;

    // Three handles, most specific first, because which ones the client has
    // depends on how far the run got. `runId` is the server's own and settles
    // it. `clientRunId` covers the window before `run-start`, when the client
    // has nothing else for a stateless first turn. `threadId` is the fallback
    // for a client that did not start this run at all — one that attached to
    // it, whose replayed tail carried no `run-start`.
    let runId = typeof body.runId === "string" ? body.runId : undefined;
    if (!runId && typeof body.clientRunId === "string") {
      runId = this.liveRuns.findByClientRunId(body.clientRunId) ?? undefined;
    }
    if (!runId && typeof body.threadId === "string") {
      runId = (await this.liveRuns.find({ threadId: body.threadId }))?.runId;
    }

    const run = runId ? this.liveRuns.get(runId) : null;
    if (!run) {
      // Already finished, already evicted, or never here. Not an error: the
      // caller wanted the run stopped and it is not running.
      return { stopped: false };
    }

    run.stop({ reason: typeof body.reason === "string" ? body.reason : undefined });

    // Deliberately not awaiting `run.result()`. Unwinding means letting tools
    // in flight settle into `denied` results and finalizing the assistant
    // message, which can take as long as the slowest tool — and a stop button
    // that spins for twenty seconds is a stop button people press twice.
    return { stopped: true };
  }

  /** `POST /<path>/files` — uploads an attachment and returns its file id. */
  async upload(req: HttpRequest<any, any> = new HttpRequest()): Promise<{ fileId: string }> {
    const form = await req.rawRequest.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new Error("upload expects a multipart body with a `file` field.");
    }
    // Straight through the provider: message history holds provider file ids,
    // which is the trade `AgentProvider.upload` documents — vision and PDF
    // input without gemi owning a storage story in v1.
    const fileId = await this.agent.provider.upload(file as File);
    return { fileId };
  }

  /**
   * Protected, not private: these exist to be overridden. `onMessage` fires for
   * every completed message, user and assistant alike, and is the intended
   * persistence point for an app that is not using `store`.
   */
  protected onMessage(message: AgentMessage, ctx: AgentHookContext): void | Promise<void> {
    void message;
    void ctx;
  }

  protected onToolCall(
    call: { toolCallId: string; name: string; input: unknown },
    ctx: AgentHookContext,
  ): void | Promise<void> {
    void call;
    void ctx;
  }

  /** Fires before the stream ends `awaiting-input` — where to notify whoever
   *  has to approve, if they are not the person watching the stream. */
  protected onAwaitingInput(
    pending: PendingToolCall[],
    ctx: AgentHookContext,
  ): void | Promise<void> {
    void pending;
    void ctx;
  }

  protected onError(error: AgentError, ctx: AgentHookContext): void | Promise<void> {
    void error;
    void ctx;
  }

  protected onStreamComplete(
    result: AgentRunResult<ToolShapesOf<A["tools"]>, any>,
    ctx: AgentHookContext,
  ): void | Promise<void> {
    void result;
    void ctx;
  }

  /**
   * WHAT HAPPENS WHEN A HOOK THROWS: it is reported and the run carries on.
   *
   * The alternative is to fail the run, and that trade is not close. These
   * hooks are an app's persistence and notification points; the run is a model
   * call the user has already been charged for and whose tools may already have
   * charged a card. Letting a failed `INSERT` in `onMessage` abort a generation
   * mid-sentence loses the answer as well as the row, and the user cannot
   * retry into a better outcome. So the answer survives and the failure is
   * logged.
   *
   * It is logged rather than routed to `onError`: `onError` is itself a hook,
   * and a hook that throws inside the handler for hooks that throw is a loop.
   * Override this to send it somewhere with a pager attached.
   */
  protected reportHookFailure(error: unknown): void {
    console.error("[gemi/ai] agent controller hook failed", error);
  }

  private async dispatchEvent(event: AgentStreamEvent, ctx: AgentHookContext): Promise<void> {
    switch (event.type) {
      case "tool-call":
        // Skipped while the arguments are still streaming: a hook that fires
        // per token would fire with a half-parsed input, which is worse than
        // firing late. And skipped for a re-sent frame, which carries a parked
        // sub-run's record on a call this hook has already seen — once per call
        // is the contract, and a run that re-parks would otherwise fire it for
        // a call some earlier run made.
        if (!event.part.partial && !event.resent) {
          await this.onToolCall(
            {
              toolCallId: event.part.toolCallId,
              name: String(event.part.name),
              input: event.part.input,
            },
            ctx,
          );
        }
        return;
      case "awaiting-input":
        await this.onAwaitingInput(event.pending as PendingToolCall[], ctx);
        return;
      case "error":
        await this.onError(event.error, ctx);
        return;
      default:
        return;
    }
  }

  /**
   * Runs after the stream is over, whether or not anyone was still watching it.
   *
   * The messages come from `result()` rather than from the event stream because
   * assembling a message out of deltas is the agent's job and doing it twice is
   * how the two copies drift. It also means a stopped run persists the same way
   * a finished one does: `stop()` finalizes the transcript, so by the time this
   * resolves there is a valid history to store.
   */
  private async persistRun(run: AgentRun, ctx: AgentHookContext): Promise<void> {
    let result: AgentRunResult<ToolShapes, unknown>;
    try {
      result = await run.result();
    } catch (err) {
      await this.safely(() =>
        this.onError(
          {
            code: "unknown",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
          ctx,
        ),
      );
      return;
    }

    const messages = result.messages as AgentMessage[];

    if (ctx.threadId && messages.length > 0) {
      try {
        await this.store.appendMessages(ctx.threadId, messages);
      } catch (err) {
        this.reportHookFailure(err);
      }
    }

    for (const message of messages) {
      await this.safely(() => this.onMessage(message, ctx));
    }

    await this.safely(() => this.onStreamComplete(result as any, ctx));
  }

  private async safely(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.reportHookFailure(err);
    }
  }
}

// --- request plumbing ----------------------------------------------------

/**
 * A body, or the reason there is not one.
 *
 * Deliberately one shape with an optional `error` rather than a discriminated
 * union on `ok`: this package compiles with `strict: false`, and without
 * `strictNullChecks` TypeScript will not narrow a union by a boolean
 * discriminant — `if (!parsed.ok)` leaves `parsed.message` an error. A field
 * that is either set or not needs no narrowing to read.
 */
type ParsedBody = { body: Record<string, any>; error?: string };

/**
 * The body, as JSON — or a reason it is not.
 *
 * Read off the raw request rather than through `req.input()`: that path matches
 * `Content-Type` exactly, so `application/json; charset=utf-8` — which several
 * HTTP clients send by default — parses as an empty body, and an agent turn
 * that silently loses its text is a bad way to find that out.
 *
 * The three cases are kept apart deliberately. NO body is a real request — a
 * reattach, or a turn that just lets the model continue — and reads as `{}`. A
 * body that will not parse, or that parses to something other than an object,
 * is a failed request and has to say so: folding it into `{}` made a truncated
 * proxy response or a mis-serialized client indistinguishable from an empty
 * turn, so `stream` billed a model call with no history and no turn and threw
 * the user's actual message away. That presents as the model hallucinating
 * rather than as an error, which is the expensive way to debug it. Pre-flight
 * failures stay ordinary HTTP errors and never reach the event stream.
 *
 * An array counts as malformed even though `typeof [] === "object"`: nothing
 * downstream reads a positional body, so `[1,2,3]` could only ever have run as
 * an empty turn.
 */
async function readJsonBody(req: HttpRequest<any, any>): Promise<ParsedBody> {
  const raw = req?.rawRequest;
  if (!raw || raw.method === "GET" || raw.method === "HEAD" || !raw.body) {
    return { body: {} };
  }

  let text: string;
  try {
    text = await raw.text();
  } catch {
    // A body that stopped arriving mid-flight. Same class of failure as one
    // that arrived truncated, and the same answer.
    return { body: {}, error: "The request body could not be read." };
  }

  if (!text.trim()) {
    return { body: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: {}, error: "The request body is not valid JSON." };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: {}, error: "The request body must be a JSON object." };
  }

  return { body: parsed as Record<string, any> };
}

function invalidRequest(message: string): Response {
  return jsonResponse(400, { code: "invalid_request", message });
}

/**
 * The client's turn, accepting both `{ turn: {...} }` and the flattened
 * `{ text, files, toolResults }` — the second is what a hand-written `fetch`
 * writes, and refusing it buys nothing.
 *
 * Returns `undefined` for an empty turn, which is a real request: reattaching
 * to a conversation and letting the model continue is a turn with nothing in
 * it.
 */
function toClientTurn(body: Record<string, any>): ClientTurn | undefined {
  const source = body.turn && typeof body.turn === "object" ? body.turn : body;
  const turn: ClientTurn = {};
  if (typeof source.text === "string") {
    turn.text = source.text;
  }
  if (Array.isArray(source.files)) {
    turn.files = source.files;
  }
  if (Array.isArray(source.toolResults)) {
    turn.toolResults = source.toolResults;
  }
  return Object.keys(turn).length > 0 ? turn : undefined;
}

/**
 * Where to resume from, or `undefined` for "wherever you still can".
 *
 * An explicit `from` wins, because a client that tracked its own position knows
 * something the transport does not. Otherwise `Last-Event-ID` — the browser
 * sends it on its own when an `EventSource` reconnects, and the frames put
 * `seq` in `id:` precisely so that header is already the right question. It
 * names the last event *received*, so the resume point is one past it.
 *
 * With neither, the answer is `undefined` and NOT 0. A client reattaching on
 * mount is a fresh POST from a page that has just loaded: no `Last-Event-ID`,
 * and no cursor of its own, because the only handle it was given is the
 * `threadId`. Reading that as "resume from frame 0" asked `replay` for a frame
 * every run longer than `maxFrames` has already evicted, so the mount-time
 * reattach — the one case `/attach` exists for — 410'd on exactly the long runs
 * it was meant to rescue, and the documented remedy of reloading the thread
 * does not help because the store is only written at run end. `undefined` means
 * the tail, which is all such a client can use anyway.
 */
function resolveCursor(req: HttpRequest<any, any>, body: Record<string, any>): number | undefined {
  if (typeof body.from === "number" && Number.isFinite(body.from)) {
    return Math.max(0, Math.floor(body.from));
  }
  // `cursor` is what `useChat` actually sends, and it counts the other way:
  // `from` is the frame to resume AT, `cursor` the last frame the client
  // APPLIED — the same convention as `Last-Event-ID`, and the same `+ 1`. A
  // client that has applied nothing sends -1, which is not a position but the
  // absence of one, so it falls through to the tail rather than asking for
  // frame 0 and 410ing on precisely the long runs `/attach` exists to rescue.
  if (typeof body.cursor === "number" && Number.isFinite(body.cursor)) {
    const applied = Math.floor(body.cursor);
    if (applied >= 0) {
      return applied + 1;
    }
    return undefined;
  }
  const header = req?.rawRequest?.headers?.get("Last-Event-ID");
  if (header) {
    const seq = Number.parseInt(header, 10);
    if (Number.isFinite(seq)) {
      return Math.max(0, seq + 1);
    }
  }
  return undefined;
}

function searchParam(req: HttpRequest<any, any>, key: string): string | undefined {
  const value = req?.search?.get(key);
  return typeof value === "string" ? value : undefined;
}

function jsonResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- routing -------------------------------------------------------------
//
// `agent()` itself belongs on ApiRouter next to `resource()`, which is the
// method it works like: one call, several routes, all of them the controller's.
// The types are declared here because they are the ai module's contract, not
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
