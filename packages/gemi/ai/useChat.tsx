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
} & Record<string, unknown>;

/** What `POST /api<path>/attach` receives: which thread, and how far this client
 *  already got. */
export type AgentAttachBody = { threadId: string; cursor: number };

let localIdCounter = 0;

/** Ids for messages the client authored. Server-assigned ids are what keep a
 *  reattached stream from duplicating a message, so the two must not collide. */
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
  try {
    const data = (await response.json()) as { error?: { message?: string }; message?: string };
    message = data?.error?.message ?? data?.message ?? message;
  } catch {
    // Not JSON. The status line is all there is.
  }
  return {
    code: response.status === 429 ? "rate_limited" : "unknown",
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
    attach: attachOnMount = true,
    body: extraBody,
    headers,
    onFinish,
    onError,
    onAwaitingInput,
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
    });
  }
  const [state, setState] = useState<ChatState<any, any>>(stateRef.current);
  const [phase, setPhase] = useState<"idle" | "submitted" | "streaming">("idle");

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // The latest callbacks, so a stream started three renders ago still calls the
  // ones the component has now instead of a stale closure.
  const handlers = useRef({ onFinish, onError, onAwaitingInput });
  handlers.current = { onFinish, onError, onAwaitingInput };
  const requestRef = useRef({ base, headers, extraBody });
  requestRef.current = { base, headers, extraBody };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
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

  const fail = useCallback(
    (error: AgentError) => {
      commit({ ...stateRef.current!, error, pending: [] });
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
          const message = next.messages.find((m: AgentMessage) => m.id === event.messageId);
          if (message) handlers.current.onFinish?.(message);
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
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const history = stateRef.current!.messages;
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
        ...stateRef.current!,
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
          ...(stateRef.current!.threadId
            ? { threadId: stateRef.current!.threadId }
            : { messages: history }),
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
        if (abortRef.current === controller) {
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

  const resultFor = useCallback(
    (toolCallId: string, build: (signature: string) => ClientToolResult) => {
      const call = stateRef.current!.pending.find(
        (candidate: PendingToolCall) => candidate.toolCallId === toolCallId,
      );
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
      // The signature travels back exactly as it arrived. It signs the input the
      // server proposed, so an app that never touches it cannot approve one
      // thing and have another run.
      return build(call.signature);
    },
    [fail],
  );

  const approve = useCallback(
    async (toolCallId: string, approved: boolean, reason?: string) => {
      const result = resultFor(toolCallId, (signature) => ({
        toolCallId,
        signature,
        approve: approved,
        ...(reason ? { reason } : {}),
      }));
      if (result) await queueResult(result);
    },
    [queueResult, resultFor],
  );

  const answer = useCallback(
    async (toolCallId: string, output: unknown) => {
      const result = resultFor(toolCallId, (signature) => ({ toolCallId, signature, output }));
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
    abortRef.current?.abort();
    abortRef.current = null;
    commit(markAborted(stateRef.current!));
    setPhaseSafe("idle");
    if (!runId) return;
    try {
      await post(`${url}/stop`, { runId, threadId });
    } catch {
      // The run may still be going server-side, but the transcript already says
      // it was cut and there is nothing useful to retry from here.
    }
  }, [commit, post, setPhaseSafe]);

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
    abortRef.current = controller;
    void (async () => {
      try {
        const body: AgentAttachBody = { threadId: initialThreadId, cursor: stateRef.current!.seq };
        const response = await post(`${requestRef.current.base}/attach`, body, controller.signal);
        // Nothing running is the ordinary answer, not a failure: the route says
        // so with an empty response and the screen simply stays as it was.
        if (!response.ok || response.status === 204 || !response.body) return;
        await consume(response, controller.signal);
      } catch {
        // A probe that could not be made leaves the client exactly where a
        // client without `attach` would be — with its own history and no run.
      } finally {
        if (abortRef.current === controller) {
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
    sendMessage,
    stop,
    regenerate,
    setMessages,
    pending: state.pending as PendingToolCall<ToolsOf<P>>[],
    approve,
    answer,
    attach: uploadFile,
  };
}
