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
  ToolCallPart,
  ToolProgress,
  ToolResultPart,
  ToolShapes,
  Usage,
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
 * The extra body fields the route's controller declared, or an open record for
 * one that declared none.
 *
 * The fallback is not just for an undeclared body: it also covers a route
 * whose `RPC` entry predates this field, which is every entry in an app that
 * has not regenerated its types yet. Falling back to the old signature there
 * is the difference between an upgrade that compiles and one that does not.
 */
type BodyOf<P extends keyof AgentRoutes> = AgentRoutes[P] extends { body: infer B }
  ? B
  : Record<string, unknown>;

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
   *  sends it with each request — the stateless default.
   *
   *  The id is the store's, not the client's: an app route calls
   *  `store.createThread` and hands the result to this hook, and an id the
   *  store never minted — or has since expired — is a `thread_not_found` error
   *  on the first turn. Only a store built with client-owned ids
   *  (`new MemoryAgentStore({ clientOwnedIds: true })`) takes one the client
   *  made up. */
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
  /**
   * Ask again, the same way, each time the page comes back into view: the tab
   * is shown again (`visibilitychange`) or the window regains focus (#778).
   *
   * For a thread more than one client posts on, two tabs or two devices.
   * `attach` only asks on mount, so a chat that was already open misses a run
   * another client starts later; this picks it up when the user looks. One
   * small request per return to the page, never while this chat is already
   * sending or streaming, and nothing at all while the page stays in view.
   * An app with a change feed of its own does better calling `reattach()`
   * from it. Defaults to false; needs a thread, like `attach`.
   */
  reattachOnFocus?: boolean;
  /**
   * Merged into the request body, and read back on the server in
   * `instructions(req, { body })` and on every tool's `ctx.body`. `uploadFile`
   * sends it too, as a `body` form part, so the controller's
   * `attachmentScope(req, threadId, { body })` and `authorizeRequest` see the
   * same fields on an upload as on a turn.
   *
   * Typed by the controller: a controller written as `AgentController<typeof
   * agent, { pageId: string }>` has this checked against that shape, and one
   * that declares no body leaves it the open record it has always been. It
   * stays optional either way — a required field of a declared body is enforced
   * when `body` is given, not by forcing every caller to pass one.
   *
   * The four names the turn envelope owns — `turn`, `clientRunId`, `threadId`,
   * `messages` — are written after this, so naming one here has no effect: the
   * framework's value replaces yours. Two of them are not even ignored on
   * arrival: exactly one of `threadId` and `messages` is written as `undefined`
   * on any given turn — `threadId` on a turn with no thread yet, `messages` once
   * there is one — and `JSON.stringify` drops the key, so a value you put there
   * never reaches the server at all. Pick another name for anything it must see.
   *
   * The envelope has to win rather than be tidied up afterwards, because
   * `threadId` and `turn` are read off the top level before the app's fields are
   * separated out.
   */
  body?: BodyOf<P>;
  headers?: Record<string, string>;
  onFinish?: (message: AgentMessage<ToolsOf<P>, OutputOf<P>>) => void;
  /**
   * Fires once for each of the agent's tool results, as it arrives.
   *
   * For acting on a result without waiting for the turn to finish: a tool that
   * has changed something server-side is worth refetching for immediately, and
   * `onFinish` does not come until the agent has written its closing message.
   * A turn that edits three things fires this three times.
   *
   * `part` is the discriminated union of the agent's tools, so `part.name ===
   * "editComponent"` narrows `part.output` — and `part.status` has to be checked
   * before reading it, since a result can be an error or a refusal.
   *
   * ONLY FOR RESULTS THAT ARE NEW HERE. A reattach, a retrying proxy, or a run
   * replayed from the top onto a restored transcript all redeliver results this
   * client already has, and an app that writes to a database in here must not
   * do it twice. Keyed on `toolCallId`, which is the id the transcript upserts
   * on, so nothing has to be deduped by the app.
   *
   * A SUB-AGENT'S TOOLS DO NOT FIRE IT. Their results arrive as nested frames
   * inside the parent tool call that started them, and belong to that call
   * rather than to this conversation. What fires here is what this agent
   * called.
   */
  onToolResult?: (part: ToolResultPart<ToolsOf<P>>) => void;
  /**
   * Fires once for each value a tool yields, as it arrives.
   *
   * `onToolResult` for tools that finish in stages: a tool that saves its work
   * piece by piece and yields after each piece is worth refetching for after
   * each yield, not only when it returns. `name` narrows `data` to what that
   * tool yields.
   *
   * ONLY FOR VALUES THAT ARE NEW HERE, for the reason `onToolResult` gives. A
   * redelivered frame, or one for a call whose message already finished, is
   * dropped by the reducer, and this fires only when the call's `progress`
   * actually grew.
   *
   * A SUB-AGENT'S TOOLS DO NOT FIRE IT, like `onToolResult`: their progress
   * arrives inside nested frames and belongs to the call that started them.
   */
  onToolProgress?: (progress: ToolProgress<ToolsOf<P>>) => void;
  onError?: (error: AgentError) => void;
  onAwaitingInput?: (pending: PendingToolCall<ToolsOf<P>>[]) => void;
  /**
   * The mount probe found no run to attach to. So did a `reattachOnFocus`
   * probe; an explicit `reattach()` answers `false` instead.
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
   * On a thread it stops the thread's run even when this chat did not start it
   * and is not streaming it: idle, it asks the route to stop whatever is
   * running on `threadId` (#778). That is a run another tab started, which
   * this one shows as busy from a re-read thread. Without a thread and with
   * nothing in flight there is nothing to name, and nothing is sent.
   *
   * The UI stops immediately; the server call is what actually ends the
   * generation and any tool mid-flight. `messages` keeps the interrupted turn
   * with everything it had produced, marked `aborted`, so the transcript shows
   * where it was cut rather than losing text the user already read.
   */
  stop(): Promise<void>;
  /**
   * Ask the thread now whether a run is going, and if one is, stream it into
   * this chat (#778).
   *
   * The probe the mount does (`attach`), on demand. For a thread more than one
   * client posts on: a chat that is already open learns nothing of a run
   * another tab or device starts on it later, and this is how it picks that
   * run up. Once attached it is this chat's run in every way that shows:
   * `status` is `streaming`, `onToolResult`, `onToolProgress` and `onFinish`
   * fire for what is new here, and `stop()` stops it.
   *
   * Resolves `true` once an attached run's stream has ended, and `false` at
   * once when there was nothing to attach to: no thread yet, this chat already
   * sending or streaming, or no run going on the thread in this process (the
   * same ambiguity `onAttachMiss` describes, which this does not fire, since
   * the caller has the answer). Cheap when there is nothing: one small request
   * and no change to `status`.
   *
   * Call it from whatever tells the app the thread changed (a change feed, a
   * push, a "someone is typing" signal), or set `reattachOnFocus` to have the
   * hook ask whenever the page comes back into view. The question the run
   * answers comes with it, so the chat does not need to re-read the thread
   * first; if it does re-read (and `setMessages` what it read), a run caught
   * halfway is rebuilt from its first frame rather than appended to.
   */
  reattach(): Promise<boolean>;
  /**
   * Drops the last assistant turn and re-runs from the user turn before it.
   * On a thread the server replaces its stored answer too (`regenerate: true`
   * on the request), so the model sees the question once, not a repeat.
   */
  regenerate(): Promise<void>;
  /**
   * Replaces the local transcript. Client-only: on a thread the server keeps
   * its own history, and this does not change what the next turn is run on.
   */
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
   * The run's total usage so far — every step plus what its tools spent — or
   * `undefined` before the first `usage` frame. Run-scoped like `loadedTools`.
   * Each assistant message carries its own share on `message.usage` (#467).
   */
  usage: Usage | undefined;
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

  /**
   * Uploads through the agent's own upload route and returns the handles for
   * the file. Here rather than in app code because the route is derived from
   * the same path.
   *
   * TWO IDS, BOTH OPTIONAL, AND THE OPTIONALITY IS LOAD-BEARING. `fileId` is the
   * provider's, and is what lets the model look at the file; `attachmentId` is
   * gemi's, and is the handle a tool resolves to get the bytes. A file routed to
   * storage only has no `fileId`, and an upload the server had no scope for has
   * no `attachmentId` — see `AgentController.attachmentScope`. Pass the answer
   * on whole, `sendMessage({ files: [await attach(f)] })`: the model is shown
   * the file when there is a `fileId` and told its `attachmentId` when there is
   * one, which is what lets it hand the file to a tool.
   *
   * Picking one id out is the mistake: `const { fileId } = await attach(f);
   * sendMessage({ files: [{ fileId }] })` typechecks, because a turn's
   * `fileId` is optional too, and for a storage-only upload it sends an entry
   * with no id at all. The compiler will not catch that; the agent route does,
   * and answers 400 `invalid_request` before a run starts or anything is
   * stored. It is refused at the door rather than dropped, because a dropped
   * file leaves the model answering about something it never got, and a stored
   * one makes the request builder throw on every later turn of the thread.
   * What the optional type does catch, under `strictNullChecks`, is code that
   * reads `fileId` as a `string` — rendering it, or handing it to a vendor.
   *
   * A FAILED UPLOAD IS THAT FILE'S PROBLEM, NOT THE CONVERSATION'S (#683). The
   * promise rejects with an `AttachError` (`{ code, message, status }`, the
   * server's own code and sentence, e.g. `unsupported_file_type`), and nothing
   * else changes: `error`, `status` and `onError` are the chat's, and a
   * composer marks the one chip. `options.signal` aborts the upload and
   * rejects with a `DOMException` named `AbortError`; nothing is stored.
   * `options.onProgress` reports bytes sent, and is why the upload goes over
   * `XMLHttpRequest` when it is given — `fetch` cannot report upload progress.
   * The hook's `threadId`, once it has one, goes with the upload, so an
   * unauthenticated chat on a thread has a scope to keep the file under.
   */
  attach(
    file: File,
    options?: AttachOptions,
  ): Promise<{
    fileId?: string;
    attachmentId?: string;
    name: string;
    mimeType: string;
    /**
     * Set when the server wanted to keep this file and had no scope to keep it
     * under — a missing `attachmentId` that is a misconfigured route rather
     * than the app's policy. See `AgentController.attachmentScope`.
     */
    downgraded?: "no_scope";
  }>;
}

/** The second argument to `attach()`. */
export type AttachOptions = {
  /** Aborts the upload. The promise rejects with a `DOMException` named
   *  `AbortError`, and the server keeps nothing. */
  signal?: AbortSignal;
  /** Bytes sent so far. `total` is 0 when the browser cannot tell. Giving this
   *  sends the upload with `XMLHttpRequest`, which can report it. */
  onProgress?: (progress: { loaded: number; total: number }) => void;
};

/**
 * Why `attach()` rejected, for that file alone.
 *
 * `code` is the server's when it sent one — `unsupported_file_type`,
 * `file_too_large`, `file_rejected` and `invalid_request` from
 * `AgentController.upload`, or a framework refusal's `kind` such as
 * `authentication` — and otherwise `upload_failed` (an answer that was
 * not JSON, `status` says which) or `network_error` (no answer at all). A
 * string rather than a union, because an app's own `attachmentDestination`
 * can throw an error with a code of its own and that has to arrive intact.
 */
export class AttachError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AttachError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
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
  /**
   * Threaded only: replace the thread's last answer instead of answering after
   * it. The server removes the last user turn and everything after it from the
   * store and runs that turn again (#451). Sent by `regenerate()`.
   */
  regenerate?: boolean;
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

type UploadAnswer = { status: number; statusText: string; body: string };

function abortError(): DOMException {
  return new DOMException("The upload was aborted.", "AbortError");
}

/** No progress wanted: `fetch`, which aborts on the signal by itself. */
async function fetchUpload(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<UploadAnswer> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: form, signal });
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw abortError();
    throw new AttachError(
      "network_error",
      error instanceof Error && error.message ? error.message : "The upload could not be sent.",
    );
  }
  try {
    return {
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    };
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw abortError();
    throw new AttachError("network_error", "The upload's answer could not be read.");
  }
}

/**
 * Progress wanted: `XMLHttpRequest`, the one browser API that reports bytes
 * sent. Settled on `load`/`error`/`timeout`/`abort`, never on `readyState` 4,
 * which an abort reaches too with status 0 (#671 is that bug in `useUpload`).
 */
function xhrUpload(
  url: string,
  form: FormData,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onProgress: (progress: { loaded: number; total: number }) => void,
): Promise<UploadAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.addEventListener("load", () => {
      done();
      resolve({ status: xhr.status, statusText: xhr.statusText, body: xhr.responseText });
    });
    xhr.addEventListener("abort", () => {
      done();
      reject(abortError());
    });
    const failed = () => {
      done();
      reject(new AttachError("network_error", "The upload could not be sent."));
    };
    xhr.addEventListener("error", failed);
    xhr.addEventListener("timeout", failed);
    xhr.upload.addEventListener("progress", (event) => {
      // An app's callback throwing must not take the upload with it.
      try {
        onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 });
      } catch {
        // Ignored: progress is a report, not part of the upload.
      }
    });
    xhr.open("POST", url, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(form);
  });
}

/** A non-2xx answer as the file's error: the server's code and sentence when
 *  it sent `{ error: { code, message } }`, the status line when it did not. */
function attachErrorFrom(answer: UploadAnswer): AttachError {
  let code = "upload_failed";
  let message = answer.statusText || `The upload failed with status ${answer.status}.`;
  try {
    const data = JSON.parse(answer.body) as {
      error?: string | { code?: unknown; kind?: unknown; message?: unknown };
      message?: unknown;
    };
    const error = data?.error;
    if (typeof error === "string") {
      // An older server's bare refusal string.
      if (error) message = error;
    } else {
      // `code` is the agent route's own (`unsupported_file_type`); `kind` is a
      // framework refusal's (`authentication` from an `auth` middleware, #673).
      const named = error?.code ?? error?.kind;
      if (typeof named === "string" && named) code = named;
      const text = error?.message ?? data?.message;
      if (typeof text === "string" && text) message = text;
    }
  } catch {
    // Not JSON: a proxy's error page, say. The status line is all there is.
  }
  return new AttachError(code, message, answer.status);
}

function turnFrom(message: AgentMessage): ClientTurn {
  let text = "";
  const files: NonNullable<ClientTurn["files"]> = [];
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    // Both ids, or a regenerated turn loses the one a tool needs: the model
    // is told the `attachmentId` only because the turn carried it. An absent
    // `fileId` stays absent — a storage-only upload — rather than going out as
    // an explicit `undefined` the server has to tell apart from a wrong value.
    if (part.type === "file") {
      files.push({
        ...(part.fileId ? { fileId: part.fileId } : {}),
        ...(part.attachmentId ? { attachmentId: part.attachmentId } : {}),
        name: part.name,
        mimeType: part.mimeType,
      });
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
 * The tool call an id names, searched from the newest message back.
 *
 * A `tool-progress` frame names a call and no message, so the message has to be
 * found rather than told — the same scan `withToolCall` does in the reducer,
 * and newest-first for the same reason it gives: the call being worked on is
 * the one that just arrived, and this runs twice per yield on a log a tool
 * decides the length of.
 *
 * A second copy rather than an export of the reducer's, deliberately.
 * `ai/client/index.ts` documents `reducer.ts` as `useChat`'s internals, and the
 * two want different things anyway: that one takes an updater and rebuilds the
 * state around it, while this is a read — it answers which tool yielded, off a
 * state the reducer has already finished with.
 */
function findToolCall(messages: AgentMessage[], toolCallId: string): ToolCallPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const part = messages[i]!.content.find(
      (candidate) => candidate.type === "tool-call" && candidate.toolCallId === toolCallId,
    );
    if (part) return part as ToolCallPart;
  }
  return undefined;
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
    reattachOnFocus = false,
    body: extraBody,
    headers,
    onFinish,
    onToolResult,
    onToolProgress,
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
  const handlers = useRef({
    onFinish,
    onToolResult,
    onToolProgress,
    onError,
    onAwaitingInput,
    onAttachMiss,
  });
  handlers.current = {
    onFinish,
    onToolResult,
    onToolProgress,
    onError,
    onAwaitingInput,
    onAttachMiss,
  };
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

  /**
   * The server call that ends a run. Shared by `stop()` and by a `send` that
   * supersedes one; what each does with a failure is its own, because a stop
   * that did not land is a run still working through its tool loop and still
   * billing, behind a transcript that says it was cut — and whose problem that
   * is depends on who asked.
   */
  const postStop = useCallback(
    async (body: AgentStopBody, report: (error: AgentError) => void) => {
      const { base: url } = requestRef.current;
      try {
        const response = await post(`${url}/stop`, body);
        if (!response.ok) report(await httpError(response));
      } catch (error) {
        if (isAbort(error)) return;
        report({
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    },
    [post],
  );

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
        } else if (event.type === "tool-result") {
          // The same guard `onFinish` needs, keyed on what identifies a result.
          // `seq` catches an ordinary redelivery, but a run replayed from the top
          // onto a restored transcript is all new to the cursor.
          //
          // Deliberately broader than the reducer's own dedupe, which upserts
          // within one message (`withMessage(state, event.messageId, …)`): a
          // result redelivered under a different `messageId` becomes a second
          // part in the transcript, and this still will not announce it. An app
          // writing to a database here wants the broader rule — announcing once
          // per `toolCallId` is what makes the write safe to leave un-deduped.
          const had = previous.messages.some((message: AgentMessage) =>
            message.content.some(
              (part) => part.type === "tool-result" && part.toolCallId === event.part.toolCallId,
            ),
          );
          if (!had) {
            handlers.current.onToolResult?.(event.part as ToolResultPart<ToolsOf<P>>);
          }
        } else if (event.type === "tool-progress") {
          // FIRES ON THE APPEND, NOT ON THE FRAME.
          //
          // `next !== previous` above is not the guard here, because it cannot
          // be: `applyFrame` stamps the new `seq` onto a fresh object whatever
          // the reducer decided, so a value the reducer *refused* still arrives
          // as a changed state. It refuses one for a call inside a finished
          // message — a run replayed from the top onto a transcript that
          // already holds it — which is exactly the redelivery this hook must
          // not announce, and the only evidence that it happened is that the
          // log did not grow.
          //
          // The same comparison covers the other frame `withToolCall` drops on
          // purpose: one naming a tool call this transcript does not have, the
          // mid-run `/attach` case. There is no part to read a tool name off,
          // so there is nothing to announce either.
          const before = findToolCall(previous.messages, event.toolCallId);
          const after = findToolCall(next.messages, event.toolCallId);
          if (after && (after.progress?.length ?? 0) > (before?.progress?.length ?? 0)) {
            handlers.current.onToolProgress?.({
              toolCallId: after.toolCallId,
              name: after.name,
              data: event.data,
            } as ToolProgress<ToolsOf<P>>);
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
    async (turn: ClientTurn, options: { regenerate?: boolean } = {}) => {
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

      if (superseded) {
        // Aborting the fetch only closes the connection, and a closed connection
        // no longer stops a run: the superseded one would keep going server
        // side, blind to this turn and still billing. So it is stopped the way
        // `stop()` stops it, by the handles that name exactly that run — never
        // by `threadId`, which by the time this lands may name the run this
        // turn is about to start. A run this client did not start, and whose
        // `run-start` never arrived, has no such handle; the server ends it
        // anyway when the new turn reaches the thread. Not awaited: the server
        // orders the two, and a round trip before every "changed my mind" would
        // be paid for nothing.
        const { runId, threadId } = stateRef.current!;
        const body: AgentStopBody = {
          ...(runId ? { runId } : {}),
          ...(superseded.clientRunId ? { clientRunId: superseded.clientRunId } : {}),
        };
        if (Object.keys(body).length > 0) {
          // A failure here does not go through `fail`. The post is not awaited,
          // so its answer lands after this send has cleared `error` for the
          // turn going out, and a 502 from `/stop` would sit on an answer that
          // is streaming fine — a turn that succeeded, ending `error`. With a
          // thread the server ends the old run when this turn reaches it, so a
          // stop that failed changed nothing and there is nothing to say.
          // Without one this client is the only thing that knows the old run
          // is still going, so the app is told, and only told.
          void postStop(body, threadId ? () => {} : (error) => handlers.current.onError?.(error));
        }
      }

      const previous = superseded ? markAborted(stateRef.current!) : stateRef.current!;
      const history = previous.messages;
      // The id this turn's message shows under until the server's `message-id`
      // renames it (#466). The app's own when it passed one.
      const ownId = turn.localId || localId();
      const authored: AgentMessage[] =
        turn.text || turn.files?.length
          ? [
              {
                id: ownId,
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
          // The app's fields FIRST, so the envelope below wins every collision.
          // Spread last, `body: { threadId: someRecordId }` replaced the real
          // thread id on the wire — and the server reads `body.threadId`,
          // `turn`, `clientRunId` and `messages` straight off the top level
          // before it ever separates the app's fields out, so a stateless chat
          // was routed into the threaded branch and answered
          // `thread_not_found`. These four names belong to the turn envelope, so
          // an app naming one loses it: overwritten here, and for whichever of
          // `threadId`/`messages` is `undefined` this turn, dropped from the wire.
          // Cast for the same reason `Body` is `object`: an `interface` has no
          // index signature, and a spread of an unresolved type parameter is
          // refused without one.
          ...(body as Record<string, unknown> | undefined),
          // With the id of the copy just shown, so the server can say what it
          // stored it as. A turn that adds no message has no copy to name.
          turn: authored.length > 0 ? { ...turn, localId: ownId } : turn,
          clientRunId,
          // BOTH KEYS, ALWAYS, one of them `undefined` — which `JSON.stringify`
          // omits, so the wire carries exactly one of them as before.
          //
          // Written as a ternary that produced one key or the other, only that
          // one overwrote the app's `body`, and the other was left to it. So a
          // stateless turn sending `body: { threadId: someRecordId }` still put
          // a real-looking thread id on the wire and answered
          // `thread_not_found` — the exact case the reorder was supposed to
          // close, with a comment claiming it had.
          threadId: stateRef.current!.threadId,
          // Stripped of the progress logs, which no part of the server reads and
          // which every later turn would otherwise re-upload.
          messages: stateRef.current!.threadId ? undefined : forWire(history),
          // On a thread the server holds the history, so trimming the local
          // copy alone changes nothing: this asks it to drop its last answer
          // and run the turn before it again (#451). Stateless needs no flag.
          ...(options.regenerate && stateRef.current!.threadId ? { regenerate: true } : {}),
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
    [commit, consume, fail, post, postStop, setPhaseSafe],
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
    //
    // With nothing in flight and no run of its own, the thread is still a
    // handle (#778): a chat on a thread another tab is running a turn on shows
    // that run as busy, and its stop button has to reach it. The route stops
    // whatever is live on the thread, and answers `{ stopped: false }` when
    // nothing is.
    if (!inFlight && !runId && !threadId) return;
    // Three handles, any of which the route can resolve by; which ones exist
    // depends on how far the run got. `clientRunId` is the one that is always
    // there for a turn this client started, which is what closes the window.
    const body: AgentStopBody = {
      ...(runId ? { runId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(inFlight?.clientRunId ? { clientRunId: inFlight.clientRunId } : {}),
    };
    await postStop(body, fail);
  }, [commit, fail, postStop, setPhaseSafe]);

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
    await send(turn, { regenerate: true });
  }, [commit, send]);

  const setMessages = useCallback(
    (messages: AgentMessage<ToolsOf<P>, OutputOf<P>>[]) => {
      commit({ ...stateRef.current!, messages: messages as AgentMessage<any, any>[] });
    },
    [commit],
  );

  const uploadFile = useCallback(async (file: File, options: AttachOptions = {}) => {
    const { base: url, headers: extraHeaders, extraBody: body } = requestRef.current;
    const { signal, onProgress } = options;
    if (signal?.aborted) throw abortError();
    const form = new FormData();
    form.append("file", file);
    // The same `body` option every turn sends, as one JSON part, so the
    // controller's `attachmentScope` and `authorizeRequest` see on this route
    // what they see on `stream` (#603). A chat whose subject is only in the
    // body — a page id, with no user and no thread — would otherwise file its
    // uploads under no scope, or under a different one from its turns. JSON
    // rather than a field per key, so a number is still a number on arrival.
    if (body !== undefined) {
      form.append("body", JSON.stringify(body));
    }
    // The thread, when the hook has one (#683). `AgentController.upload`
    // reads it so an unauthenticated chat has something to scope the file
    // to, and only takes it if its store knows the thread. Read at call time:
    // a stateless chat gets its thread from the first `run-start`.
    const threadId = stateRef.current!.threadId;
    if (threadId) {
      form.append("threadId", threadId);
    }
    // No Content-Type: the boundary is the browser's to write.
    const answer = onProgress
      ? await xhrUpload(`${url}/files`, form, { ...extraHeaders }, signal, onProgress)
      : await fetchUpload(`${url}/files`, form, { ...extraHeaders }, signal);
    // NOT `fail()`. An upload that did not work is the file's problem, and
    // the chat's `error` and `onError` describe the conversation: setting
    // them here made a composer's refused attachment look like a failed run
    // (#683). The caller has the rejection, and that is enough.
    if (answer.status < 200 || answer.status > 299) {
      throw attachErrorFrom(answer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new AttachError(
        "upload_failed",
        "The upload answered with something that is not JSON.",
        answer.status,
      );
    }
    const data = parsed as {
      fileId?: string;
      attachmentId?: string;
      name?: string;
      mimeType?: string;
      downgraded?: "no_scope";
    };
    // The route only has to return the ids; the name and type are already
    // here, so the caller gets something it can hand straight to
    // `sendMessage`.
    //
    // TWO IDS, PASSED THROUGH SEPARATELY. `fileId` is the provider's and is
    // what lets the model look at the file — unchanged, which is why it is
    // still first and still spelled the same. `attachmentId` is gemi's, the
    // handle a tool takes, and it goes in the same `turn.files` entry: the
    // server tells the model the id beside the file, so the model can pass
    // it to a tool rather than invent one. Either can be absent — a file the
    // server kept but did not send to the provider has no `fileId`, and an
    // upload with no attachment scope has no `attachmentId` (see
    // `AgentController.attachmentScope`) — so both are optional here rather
    // than asserted.
    return {
      fileId: data.fileId,
      attachmentId: data.attachmentId,
      name: data.name ?? file.name,
      mimeType: data.mimeType ?? file.type,
      // Passed through rather than dropped: without it a missing
      // `attachmentId` looks the same to the client whether the server chose
      // not to keep the file or could not tell who was uploading it, and only
      // one of those is something to fix. The server says so once per process
      // in its own log, which nobody debugging a browser is reading.
      downgraded: data.downgraded,
    };
  }, []);

  /**
   * Ask `/attach` whether the thread has a run going, and stream it if it does.
   *
   * Shared by the mount probe, `reattachOnFocus` and `reattach()`. Skipped when
   * a request of this hook's is already in flight: a send or an attach is
   * already reading the thread's run, and a second reader would interleave the
   * same frames. `missed` says whether a miss is reported to `onAttachMiss`,
   * which only the automatic probes do. The phase is left alone until a frame
   * arrives, so a probe that finds nothing never shows as busy.
   */
  const probe = useCallback(
    async (missed: boolean): Promise<boolean> => {
      const { threadId, seq, cursorRunId } = stateRef.current!;
      if (!threadId || abortRef.current) return false;
      const controller = new AbortController();
      // No `clientRunId`: this client did not start the run, so the thread is
      // the only handle it has on it — and `/attach` needs one anyway.
      abortRef.current = { controller };
      try {
        const body: AgentAttachBody = {
          threadId,
          // Where this client left off, so the route can send the tail. Left
          // at -1 it says "I have seen nothing", and a run still inside its
          // post-`run-end` TTL replays from the top onto a transcript that
          // already holds it. A cursor from another run than the live one is
          // forfeited by the route, which then replays the live run from its
          // start — the case for a run another client started.
          cursor: seq,
          ...(cursorRunId ? { runId: cursorRunId } : {}),
        };
        const response = await post(`${requestRef.current.base}/attach`, body, controller.signal);
        // Nothing running is the ordinary answer, not a failure: the route says
        // so with an empty response and the screen simply stays as it was —
        // except that on more than one instance it is also what a refresh
        // routed away from its run gets, which is not ordinary at all. The
        // client cannot tell; `onAttachMiss` is how an app that runs more than
        // one process gets to react.
        if (!response.ok || response.status === 204 || !response.body) {
          if (missed) handlers.current.onAttachMiss?.({ threadId });
          return false;
        }
        await consume(response, controller.signal);
        return true;
      } catch {
        // A probe that could not be made leaves the client exactly where a
        // client without `attach` would be — with its own history and no run.
        return false;
      } finally {
        if (abortRef.current?.controller === controller) {
          abortRef.current = null;
          setPhaseSafe("idle");
        }
      }
    },
    [consume, post, setPhaseSafe],
  );

  const reattach = useCallback(() => probe(false), [probe]);

  useEffect(() => {
    // Mount only, deliberately: `threadId` is the handle that survives a
    // refresh, and re-probing every time it changes would race a stream that is
    // already running on it. Asking again later is `reattach()`'s job.
    if (attachOnMount === false || !initialThreadId) return;
    void probe(true);
    // The unmount effect above aborts the probe with everything else in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!reattachOnFocus || typeof window === "undefined") return;
    // `visibilitychange` and `focus` usually arrive together on a return to
    // the tab; the second finds the first's probe in flight and is skipped.
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      void probe(true);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [reattachOnFocus, probe]);

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
    reattach,
    regenerate,
    setMessages,
    pending: state.pending as PendingToolCall<ToolsOf<P>>[],
    loadedTools: state.loadedTools,
    usage: state.usage,
    approve,
    answer,
    attach: uploadFile,
  };
}
