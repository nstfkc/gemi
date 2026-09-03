import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RPC } from "../client/rpc";
import { useParams } from "../client/useParams";
import { applyFrame, initialChatState, markAborted, type ChatState } from "./client/reducer";
import { decodeSSE } from "./client/sse";
import type {
  AgentError,
  AgentMessage,
  ClientToolResult,
  ClientTurn,
  PendingToolCall,
  ToolShapes,
} from "./types";

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
   * Where the client that produced `initialMessages` left off, so `/attach` can
   * be asked for the tail rather than the whole run.
   *
   * Without it the hook has to say "I have seen nothing", and a run kept alive
   * past `run-end` — which `LiveRuns` does on purpose, so a refresh a second
   * late still sees the ending — replays from the top onto a transcript that
   * already has it. Take it from `cursor` on the previous mount and persist it
   * beside the messages; the two belong together, and restoring one without the
   * other is what produces a doubled answer.
   *
   * `runId` is half of it rather than decoration: frames number from zero in
   * every run, so a bare number cannot say whether it describes the run that is
   * live now. Given both, the server resumes when they match and replays from
   * the start when they do not.
   */
  cursor?: { runId: string; seq: number };
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
  /**
   * The mount probe found no run to attach to.
   *
   * On one server this means what it says, and there is nothing to do. On more
   * than one it is ambiguous in a way neither end can resolve: a run lives in
   * the process that started it, `find` only ever searches that process, and a
   * refresh routed to a different instance gets the same answer as a thread
   * with nothing running. The server cannot tell the two apart, so it does not
   * pretend to.
   *
   * What an app can do is re-read the thread — the run is still going wherever
   * it is, and its messages land in the store when it finishes, so refetching
   * shows the answer that the stream would have shown arriving. Without this
   * the client simply sits on its own history, and the reply appears only when
   * something else happens to reload it.
   *
   * The better fix is upstream: route a session to one instance (on Azure App
   * Service that is ARR affinity, which is on by default) so the refresh lands
   * where its run is. This is the fallback for when it does not — a scale-in,
   * a new device, a cleared cookie.
   */
  onAttachMiss?: (params: { threadId: string }) => void;
}

export interface UseChatResult<P extends keyof AgentRoutes> {
  /**
   * The transcript, tools and all.
   *
   * A `tool-call` part narrows on `name`, and with it `input`, `output` and
   * `progress` — the tool's own yields, in order, typed by what its `execute`
   * yields rather than as `unknown`. `nested` on that same part holds the
   * sub-agent runs the tool drove, each an ordinary `AgentMessage[]` with a
   * name and a label, so a component walks into it and renders it with whatever
   * it already renders `messages` with:
   *
   *   {part.type === "tool-call" && part.nested?.map((run) => (
   *     <Transcript key={run.runId} title={run.label ?? run.agent} messages={run.messages} />
   *   ))}
   *
   * Those inner messages are typed with the default `ToolShapes`, not this
   * route's: a sub-agent's tools are its own, and typing its transcript with
   * the parent's tool names would be a lie the compiler tells.
   */
  messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[];
  status: ChatStatus;
  /** Cleared by the next successful send, so a retry does not have to clear it. */
  error: AgentError | null;
  /** Set once the server has assigned one. */
  threadId?: string;
  /** The run being streamed or attached to, if any. */
  runId?: string;
  /**
   * How far this client has got, to hand back as `cursor` on the next mount.
   *
   * Persist it with `messages`: a restored transcript whose cursor was not
   * restored asks `/attach` for a run it already has, and additive deltas
   * arriving a second time are how an answer ends up printed twice. `runId` is
   * undefined until a run has named itself, and the pair is meaningless until
   * then — there is nothing to resume.
   */
  cursor: { runId?: string; seq: number };

  /**
   * The one way to advance the conversation. A string is shorthand for
   * `{ text }`; answers to pending calls go in the same turn, and may travel
   * with text.
   */
  sendMessage(turn: ClientTurn | string): Promise<void>;
  /**
   * Explicit cancel — a closed tab no longer stops a run, so this is what does.
   *
   * The UI stops immediately; the server call is what actually ends the
   * generation and any tool mid-flight. `messages` keeps the interrupted turn
   * with everything it had produced, marked `aborted`, so the transcript shows
   * where it was cut rather than losing text the user already read.
   */
  stop(): Promise<void>;
  /** Drops the last assistant turn and re-runs from the user turn before it. */
  regenerate(): Promise<void>;
  setMessages(messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[]): void;

  /**
   * Non-empty exactly when `status === "awaiting-input"`.
   *
   * A call a *sub*-agent made arrives here too, with `path` naming the chain of
   * tool calls it is nested under. Nothing else about it is different, and that
   * is the point: it is answered by `approve`/`answer` like any other, and
   * `path` is there only so a UI can say which agent is asking.
   */
  pending: PendingToolCall<ToolsOf<P>>[];
  /**
   * The deferred tools the model has pulled in during the run in flight.
   *
   * Somewhere for a UI to put "…looking for the right tool" instead of an
   * unexplained pause. Run-scoped and not part of the transcript: it says what
   * is happening now, and is empty again on the next `run-start`, so it is not
   * something to persist beside `messages`.
   */
  loadedTools: string[];
  /**
   * Sugar over `sendMessage`. The hook carries each pending call's signature —
   * and its `path`, if the question came from a sub-agent — and hands both back
   * untouched, so an app answers with a boolean and never sees the mechanism
   * that makes answering trustworthy. Answering a nested question is the same
   * call as answering a top-level one.
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
 * What `POST /api<path>` receives.
 *
 * One route for every client turn, so the body has to say which mode it is in:
 * with a `threadId` the server owns the history, without one the client carries
 * it and sends the transcript *before* this turn — the turn itself is never in
 * `messages`, or the server would see it twice.
 */
export type AgentRequestBody = {
  turn: ClientTurn;
  threadId?: string;
  messages?: AgentMessage[];
  /**
   * A handle on this run, minted before the run has one.
   *
   * `stop` needs something to name, and the server's own `runId` does not reach
   * the client until `run-start` — a gap covering the network round trip and
   * the provider's time to first token, which is precisely the window a user
   * cancels in. A thread id would do it where there is one, but the stateless
   * first turn has neither. So the client names the run it is starting, and the
   * server is expected to remember the mapping for as long as the run lives.
   */
  clientRunId: string;
} & Record<string, unknown>;

/**
 * What `POST /api<path>/attach` receives: which thread, and how far this client
 * already got.
 *
 * `runId` says which run the cursor counts within. Absent, or naming a run that
 * is not the live one, the cursor cannot be honoured and the run has to be
 * replayed from the start.
 */
export type AgentAttachBody = { threadId: string; cursor: number; runId?: string };

/**
 * What `POST /api<path>/stop` receives.
 *
 * Every field is optional because the client stops runs it cannot always name:
 * before `run-start` there is no `runId`, and a stateless first turn has no
 * `threadId` either. Whichever handle is present is enough — resolve by
 * `runId`, else by `clientRunId`, else the live run on `threadId`.
 */
export type AgentStopBody = { runId?: string; threadId?: string; clientRunId?: string };

let localIdCounter = 0;

/** Ids the client mints: messages it authored, and the correlation id it names a
 *  run by before the server has. Server-assigned ids are what keep a reattached
 *  stream from duplicating a message, so the two must not collide — hence the
 *  prefix, which also tells a server log which end invented an id. */
function localId() {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${localIdCounter++}`;
  return `local_${suffix}`;
}

/** The same substitution `useMutation` does, so a parameterised agent path
 *  behaves like every other route in the package. */
function applyRouteParams(url: string, params: Record<string, string>) {
  let out = url;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}?`, value).replace(`:${key}`, value);
  }
  return out;
}

function isAbort(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

async function httpError(response: Response): Promise<AgentError> {
  // Anything that fails before the headers flush is an ordinary HTTP error —
  // auth, validation, an unknown agent — and never reaches the stream's own
  // error event, so it has to be translated into the same shape here.
  let message = response.statusText || `Request failed with status ${response.status}`;
  let code: AgentError["code"] = response.status === 429 ? "rate_limited" : "unknown";
  try {
    const data = (await response.json()) as {
      error?: { code?: string; message?: string };
      message?: string;
    };
    message = data?.error?.message ?? data?.message ?? message;
    // The one server code an app has something to do about: the thread it
    // holds is gone, and the fix is a new one or a stateless send, neither of
    // which "unknown" would suggest. Other codes stay folded into the status,
    // because the union names what the client can act on, not what the server
    // can say.
    if (data?.error?.code === "thread_not_found") {
      code = "thread_not_found";
    }
  } catch {
    // Not JSON. The status line is all there is.
  }
  return {
    code,
    message,
    retryable: response.status === 429 || response.status >= 500,
  };
}

function turnFrom(message: AgentMessage): ClientTurn {
  let text = "";
  const files: NonNullable<ClientTurn["files"]> = [];
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    if (part.type === "file") {
      files.push({ fileId: part.fileId, name: part.name, mimeType: part.mimeType });
    }
  }
  return { ...(text ? { text } : {}), ...(files.length > 0 ? { files } : {}) };
}

/**
 * The transcript as the server needs it, without the progress logs.
 *
 * In stateless mode `send` posts the whole history on *every* turn, so anything
 * that accumulates on a message is paid for again on each one. `progress` is
 * the only part of the transcript that grows without a bound the model imposes:
 * a generator tool yielding per chunk writes an entry per chunk, and a tool that
 * yielded five thousand times would put five thousand objects in the body of
 * turn 2, turn 3, and every turn after, forever.
 *
 * Nothing server-side reads it. It is not translated into a provider message,
 * `openCalls` matches on `toolCallId`, and the resume path replays a sub-agent
 * from `nested` — which is why `nested` is kept here, recursed into rather than
 * dropped, while `progress` is not. The client's own copy is untouched: this
 * shapes the request body only, so a UI still renders every yield it received.
 */
function forWire(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    // Identity for the overwhelming majority of messages, which have neither —
    // `nested` counts because a sub-agent's own yields are the same dead weight
    // one level down.
    const touched = message.content.some(
      (part) => part.type === "tool-call" && (part.progress || part.nested),
    );
    if (!touched) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-call") return part;
        const { progress: _progress, ...rest } = part;
        return rest.nested
          ? {
              ...rest,
              nested: rest.nested.map((run) => ({ ...run, messages: forWire(run.messages) })),
            }
          : rest;
      }),
    };
  });
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
export function useChat<P extends keyof AgentRoutes>(
  path: P,
  params: UseChatParams<P> = {},
): UseChatResult<P> {
  const {
    threadId: initialThreadId,
    initialMessages,
    cursor: initialCursor,
    attach: attachOnMount = true,
    body: extraBody,
    headers,
    onFinish,
    onError,
    onAwaitingInput,
    onAttachMiss,
  } = params;

  const routeParams = useParams();
  const base = useMemo(
    // A route key may or may not carry a method prefix depending on how `RPC`
    // renders it; stripping one is free and stops `/api/POST:/chat` from being
    // a possibility.
    () => `/api${applyRouteParams(String(path).replace(/^[A-Z]+:/, ""), routeParams)}`,
    [path, routeParams],
  );

  /**
   * The state lives in a ref and is mirrored into `useState` for rendering.
   *
   * A stream applies frames faster than React commits, and the reducer needs
   * the result of the previous frame, not the value captured when the loop
   * started. The ref is the source of truth; `setState` is the notification.
   *
   * `any` inside, exact at the boundary: the wire carries erased tool shapes and
   * the route's real ones are re-asserted once, in the returned object.
   */
  const stateRef = useRef<ChatState<any, any> | null>(null);
  if (stateRef.current === null) {
    stateRef.current = initialChatState<any, any>({
      messages: initialMessages,
      threadId: initialThreadId,
      seq: initialCursor?.seq,
      cursorRunId: initialCursor?.runId,
    });
  }
  const [state, setState] = useState<ChatState<any, any>>(stateRef.current);
  const [phase, setPhase] = useState<"idle" | "submitted" | "streaming">("idle");

  const mountedRef = useRef(true);
  // The request in flight, carrying the id `stop()` names it by. The two travel
  // together because a controller with no handle can only close the connection,
  // and closing the connection is exactly what no longer stops a run.
  const abortRef = useRef<{ controller: AbortController; clientRunId?: string } | null>(null);
  // The latest callbacks, so a stream started three renders ago still calls the
  // ones the component has now instead of a stale closure.
  const handlers = useRef({ onFinish, onError, onAwaitingInput, onAttachMiss });
  handlers.current = { onFinish, onError, onAwaitingInput, onAttachMiss };
  const requestRef = useRef({ base, headers, extraBody });
  requestRef.current = { base, headers, extraBody };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.controller.abort();
      abortRef.current = null;
    };
  }, []);

  const commit = useCallback((next: ChatState<any, any>) => {
    stateRef.current = next;
    // Nothing after unmount: the stream loop is async and outlives the render
    // that started it.
    if (mountedRef.current) setState(next);
  }, []);

  const setPhaseSafe = useCallback((next: "idle" | "submitted" | "streaming") => {
    if (mountedRef.current) setPhase(next);
  }, []);

  /**
   * Report a failure without touching the conversation.
   *
   * `pending` deliberately survives. Most of what fails here has nothing to do
   * with the question the conversation is holding — an upload that 500s, an
   * answer aimed at a call this client never had — and the pending calls carry
   * the only signatures that can answer them, held nowhere else. Dropping them
   * because an unrelated request failed would leave the user unable to approve
   * anything at all, with a fresh turn (which the server reads as refusing
   * everything) the only way out.
   *
   * The failures that really do end the turn clear `pending` where they happen:
   * `send` clears it as the turn goes out, and the stream's own `error` event
   * clears it in the reducer.
   */
  const fail = useCallback(
    (error: AgentError) => {
      commit({ ...stateRef.current!, error });
      handlers.current.onError?.(error);
    },
    [commit],
  );

  const post = useCallback((url: string, payload: unknown, signal?: AbortSignal) => {
    const { headers: extraHeaders } = requestRef.current;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
      signal,
    });
  }, []);

  const consume = useCallback(
    async (response: Response, signal: AbortSignal) => {
      for await (const frame of decodeSSE(response.body)) {
        // The signal is checked here as well as by `fetch`, because `stop()`
        // has to stop the *UI* whether or not the transport under it honours an
        // abort promptly. A token that lands after the user cancelled is worse
        // than one that never arrives.
        if (!mountedRef.current || signal.aborted) return;
        setPhaseSafe("streaming");
        const previous = stateRef.current!;
        const next = applyFrame(previous, frame);
        // A frame at or below the cursor. Reattachment and retrying proxies both
        // produce these; applying the deltas again would double the text, and
        // firing `onFinish` again would double whatever the app does with it.
        if (next === previous) continue;
        commit(next);

        const event = frame.event;
        if (event.type === "message-end") {
          // Only for a message that was not already finished. `seq` catches an
          // ordinary redelivery, but a run replayed from the top onto a restored
          // transcript is all new to the cursor, and firing `onFinish` again
          // means an app that persists in it writes the message a second time.
          // A message-end is terminal, so a second one is replay by definition.
          const before = previous.messages.find((m: AgentMessage) => m.id === event.messageId);
          const message = next.messages.find((m: AgentMessage) => m.id === event.messageId);
          if (message && before?.finishReason === undefined) {
            handlers.current.onFinish?.(message);
          }
        } else if (event.type === "awaiting-input") {
          handlers.current.onAwaitingInput?.(event.pending as PendingToolCall<ToolsOf<P>>[]);
        } else if (event.type === "error") {
          handlers.current.onError?.(event.error);
        }
      }
    },
    [commit, setPhaseSafe],
  );

  const send = useCallback(
    async (turn: ClientTurn) => {
      const { base: url, extraBody: body } = requestRef.current;
      // One run at a time per hook. A second send while the first is streaming
      // is a user who changed their mind, not a request to interleave two
      // assistants into one transcript.
      //
      // The superseded turn is marked aborted as it is cut, not left to whatever
      // stamps it later: a message with no finish reason is indistinguishable
      // from one still streaming, and the next run's `run-end` would otherwise
      // find it and label an answer that stopped mid-sentence "stop". In
      // stateless mode that reason is posted back to the server on every later
      // turn, so the model would be told the interruption never happened.
      const superseded = abortRef.current;
      superseded?.controller.abort();
      const clientRunId = localId();
      const controller = new AbortController();
      abortRef.current = { controller, clientRunId };

      const previous = superseded ? markAborted(stateRef.current!) : stateRef.current!;
      const history = previous.messages;
      const authored: AgentMessage[] =
        turn.text || turn.files?.length
          ? [
              {
                id: localId(),
                role: "user",
                content: [
                  ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
                  ...(turn.files ?? []).map((file) => ({ type: "file" as const, ...file })),
                ],
                createdAt: new Date().toISOString(),
              },
            ]
          : [];

      commit({
        ...previous,
        messages: [...history, ...authored],
        // The error belonged to the attempt being retried. Leaving it up while
        // the retry streams is a UI that reports a failure and a success at once.
        error: null,
        // Answered or not, this turn resolves every pending call — the server
        // denies whatever the turn left out — so holding them would leave the UI
        // asking a question that is already settled. No local tool-result parts
        // are fabricated here: the server emits one per call, denials included,
        // and guessing at the output of a call it has not run yet would be a lie
        // the stream then contradicts.
        pending: [],
      });
      setPhaseSafe("submitted");

      try {
        const payload: AgentRequestBody = {
          turn,
          clientRunId,
          ...(stateRef.current!.threadId
            ? { threadId: stateRef.current!.threadId }
            : // Stripped of the progress logs, which no part of the server
              // reads and which every later turn would otherwise re-upload.
              { messages: forWire(history) }),
          ...body,
        };
        const response = await post(url, payload, controller.signal);
        if (!response.ok) {
          fail(await httpError(response));
          return;
        }
        await consume(response, controller.signal);
      } catch (error) {
        // An abort is `stop()` or unmount; both already put the UI where it
        // belongs, and reporting it as a failure would be wrong twice.
        if (!isAbort(error)) {
          fail({
            code: "unknown",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        }
      } finally {
        if (abortRef.current?.controller === controller) {
          abortRef.current = null;
          setPhaseSafe("idle");
        }
      }
    },
    [commit, consume, fail, post, setPhaseSafe],
  );

  const sendMessage = useCallback(
    (turn: ClientTurn | string) => send(typeof turn === "string" ? { text: turn } : turn),
    [send],
  );

  /**
   * Answers queued within one tick become one turn.
   *
   * This is not an optimisation. A turn that leaves a pending call unanswered
   * denies it, so sending three approvals as three turns would have the first
   * one refuse the other two — and the natural UI code, a loop over `pending`
   * calling `approve` for each, is exactly that shape. Coalescing on the
   * microtask is what makes the declared per-call signature safe to use the way
   * it reads.
   */
  const queued = useRef<{ results: ClientToolResult[]; flushed: Promise<void> } | null>(null);

  const queueResult = useCallback(
    (result: ClientToolResult) => {
      if (queued.current) {
        queued.current.results.push(result);
        return queued.current.flushed;
      }
      const results: ClientToolResult[] = [result];
      const flushed = Promise.resolve().then(() => {
        queued.current = null;
        return send({ toolResults: results });
      });
      queued.current = { results, flushed };
      return flushed;
    },
    [send],
  );

  /**
   * The half of a `ClientToolResult` the app never writes: the id, the
   * signature, and the path.
   *
   * All three are carried by the hook and handed back untouched, which is what
   * makes a sub-agent's question answerable with the same two lines as a
   * top-level one. `path` is absent for a call the parent's own tools made, so
   * an app cannot tell from its own code where the question came from — the only
   * difference is that `pending[i].path` is there to render if it wants to say
   * which agent is asking.
   */
  const resultFor = useCallback(
    (
      toolCallId: string,
      build: (base: { toolCallId: string; signature: string; path?: string[] }) => ClientToolResult,
    ) => {
      const matches = stateRef.current!.pending.filter(
        (candidate: PendingToolCall) => candidate.toolCallId === toolCallId,
      );
      const call = matches[0];
      if (!call) {
        // Not a network failure: the app answered a call this client is not
        // holding. Surfacing it beats sending a turn the server will reject for
        // a missing signature, which is where it would otherwise show up.
        fail({
          code: "invalid_tool_result",
          message: `No pending tool call ${toolCallId}`,
          toolCallId,
          retryable: false,
        });
        return null;
      }
      if (matches.length > 1) {
        // Nesting is what makes this reachable: two sub-runs, under two
        // different tools of the same parent turn, each holding a call. The ids
        // come from whichever provider ran each sub-run, so nothing guarantees
        // they differ, and the path is what tells them apart — but `approve` is
        // deliberately addressed by id alone, because an app must not have to
        // know a question was nested to answer it. Refusing beats guessing:
        // picking one would silently approve a tool the user was not looking at.
        fail({
          code: "invalid_tool_result",
          message: `Ambiguous tool call ${toolCallId}: ${matches.length} pending calls share it`,
          toolCallId,
          retryable: false,
        });
        return null;
      }
      // The signature travels back exactly as it arrived. It signs the input the
      // server proposed — and, for a nested call, the path it was proposed at —
      // so an app that never touches either cannot approve one thing and have
      // another run, or have the right answer applied to the wrong sub-agent.
      return build({
        toolCallId,
        signature: call.signature,
        ...(call.path ? { path: call.path } : {}),
      });
    },
    [fail],
  );

  const approve = useCallback(
    async (toolCallId: string, approved: boolean, reason?: string) => {
      const result = resultFor(toolCallId, (base) => ({
        ...base,
        approve: approved,
        ...(reason ? { reason } : {}),
      }));
      if (result) await queueResult(result);
    },
    [queueResult, resultFor],
  );

  const answer = useCallback(
    async (toolCallId: string, output: unknown) => {
      const result = resultFor(toolCallId, (base) => ({ ...base, output }));
      if (result) await queueResult(result);
    },
    [queueResult, resultFor],
  );

  const stop = useCallback(async () => {
    const { base: url } = requestRef.current;
    const { runId, threadId } = stateRef.current!;
    // The UI stops now. The POST below is what actually ends the generation and
    // any tool mid-flight, and it may take a moment; a user who clicked stop
    // must not keep watching tokens arrive while it flies.
    const inFlight = abortRef.current;
    inFlight?.controller.abort();
    abortRef.current = null;
    commit(markAborted(stateRef.current!));
    setPhaseSafe("idle");
    // Whether there is anything to stop is a question about the *request*, not
    // about `runId`. Gating on `runId` meant the whole time-to-first-token
    // window — the seconds a user is most likely to cancel in, and longer when
    // the agent searches for deferred tools first — silently posted nothing,
    // leaving a tool loop running that a dropped connection does not touch. The
    // same hole reopened on a correct attach, whose tail carries no `run-start`.
    if (!inFlight && !runId) return;
    // Three handles, any of which the route can resolve by; which ones exist
    // depends on how far the run got. `clientRunId` is the one that is always
    // there for a turn this client started, which is what closes the window.
    const body: AgentStopBody = {
      ...(runId ? { runId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(inFlight?.clientRunId ? { clientRunId: inFlight.clientRunId } : {}),
    };
    try {
      const response = await post(`${url}/stop`, body);
      // A failed stop is not cosmetic. The transcript says the turn was cut, so
      // the UI looks settled, while the run may still be working through its
      // tool loop and still billing for it — the one failure here a user would
      // want to know about, and previously the one that was swallowed.
      if (!response.ok) fail(await httpError(response));
    } catch (error) {
      if (isAbort(error)) return;
      fail({
        code: "unknown",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }, [commit, fail, post, setPhaseSafe]);

  const regenerate = useCallback(async () => {
    const messages = stateRef.current!.messages as AgentMessage[];
    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        assistantIndex = i;
        break;
      }
    }
    if (assistantIndex === -1) return;
    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex === -1) return;

    const turn = turnFrom(messages[userIndex]!);
    // The user turn goes too, because `send` re-appends it. Keeping it here and
    // sending it again would show the question twice.
    commit({
      ...stateRef.current!,
      messages: messages.slice(0, userIndex),
      pending: [],
      error: null,
    });
    await send(turn);
  }, [commit, send]);

  const setMessages = useCallback(
    (messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[]) => {
      commit({ ...stateRef.current!, messages: messages as AgentMessage<any, any>[] });
    },
    [commit],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      const { base: url, headers: extraHeaders } = requestRef.current;
      const form = new FormData();
      form.append("file", file);
      // No Content-Type: the boundary is the browser's to write.
      const response = await fetch(`${url}/files`, {
        method: "POST",
        headers: { ...extraHeaders },
        body: form,
      });
      if (!response.ok) {
        const error = await httpError(response);
        fail(error);
        throw new Error(error.message);
      }
      const data = (await response.json()) as { fileId: string; name?: string; mimeType?: string };
      // The route only has to return the id; the name and type are already here,
      // so the caller gets something it can hand straight to `sendMessage`.
      return {
        fileId: data.fileId,
        name: data.name ?? file.name,
        mimeType: data.mimeType ?? file.type,
      };
    },
    [fail],
  );

  useEffect(() => {
    // Mount only, deliberately: `threadId` is the handle that survives a
    // refresh, and re-probing every time it changes would race a stream that is
    // already running on it.
    if (attachOnMount === false || !initialThreadId) return;
    const controller = new AbortController();
    // No `clientRunId`: this client did not start the run, so the thread is the
    // only handle it has on it — and `/attach` needs one anyway.
    abortRef.current = { controller };
    void (async () => {
      try {
        const body: AgentAttachBody = {
          threadId: initialThreadId,
          // The cursor the caller restored alongside `initialMessages`, so the
          // route can send the tail. Left at -1 it says "I have seen nothing",
          // and a run still inside its post-`run-end` TTL replays from the top
          // onto a transcript that already holds it.
          cursor: stateRef.current!.seq,
          ...(stateRef.current!.cursorRunId ? { runId: stateRef.current!.cursorRunId } : {}),
        };
        const response = await post(`${requestRef.current.base}/attach`, body, controller.signal);
        // Nothing running is the ordinary answer, not a failure: the route says
        // so with an empty response and the screen simply stays as it was —
        // except that on more than one instance it is also what a refresh
        // routed away from its run gets, which is not ordinary at all. The
        // client cannot tell; `onAttachMiss` is how an app that runs more than
        // one process gets to react.
        if (!response.ok || response.status === 204 || !response.body) {
          handlers.current.onAttachMiss?.({ threadId: initialThreadId });
          return;
        }
        await consume(response, controller.signal);
      } catch {
        // A probe that could not be made leaves the client exactly where a
        // client without `attach` would be — with its own history and no run.
      } finally {
        if (abortRef.current?.controller === controller) {
          abortRef.current = null;
          setPhaseSafe("idle");
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status: ChatStatus =
    // Ordered so the declared invariant — `pending` non-empty exactly when the
    // status is `awaiting-input` — is true by construction rather than by
    // everything downstream remembering to keep it.
    state.pending.length > 0
      ? "awaiting-input"
      : phase !== "idle"
        ? phase
        : state.error
          ? "error"
          : "idle";

  return {
    messages: state.messages as AgentMessage<ToolsOf<P>, OutputOf<P>>[],
    status,
    error: state.error,
    threadId: state.threadId,
    runId: state.runId,
    cursor: { runId: state.cursorRunId, seq: state.seq },
    sendMessage,
    stop,
    regenerate,
    setMessages,
    pending: state.pending as PendingToolCall<ToolsOf<P>>[],
    loadedTools: state.loadedTools,
    approve,
    answer,
    attach: uploadFile,
  };
}
