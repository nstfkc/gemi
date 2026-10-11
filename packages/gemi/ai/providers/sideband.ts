import type { Usage } from "../types";
import type { RealtimeSession } from "./realtime";
import { toRealtimeUsage, toVendorSession } from "./realtime";

/**
 * A realtime call's sideband: the server's own WebSocket to a call the browser
 * joined over WebRTC (`wss://…/realtime?call_id=…`).
 *
 * WHY IT EXISTS. The browser holds the audio; the server holds the authority.
 * Every function call the voice model makes arrives here, and so does every
 * `response.done` with its usage — so tools run with the server's checks and
 * metering does not depend on what a browser chooses to report. The server can
 * also end the call (`hangup`), which a browser-only design cannot.
 *
 * THE EVENTS ARE THE VENDOR'S, as documented for the GA Realtime API, with two
 * additions and one normalisation:
 *
 * - `response.done` gains `usage`, gemi's `Usage` (audio tokens included).
 * - `sideband.reconnected` and `sideband.closed` are gemi's own, so a consumer
 *   iterating events learns about the connection in the same loop.
 * - The beta names for transcript and text deltas are renamed to the GA ones
 *   (`response.audio_transcript.delta` → `response.output_audio_transcript.delta`),
 *   so code written against one surface does not miss events on the other.
 *
 * Keeping the vendor's names — rather than mapping each event onto gemi's — is
 * a deliberate trade: the protocol has some forty server events, the vendor
 * adds more, and a mapping layer would drop every one it did not know. An
 * unknown event arrives as itself, with its own `type`.
 *
 * VERIFIED against the documented protocol through fixtures only; see
 * `realtime.ts`. Whether Azure accepts `call_id` on its sideband the way OpenAI
 * does is the open question #921 records.
 */

// --- events ----------------------------------------------------------------

/** The vendor's error envelope on an `error` event. */
export type RealtimeErrorDetail = {
  type?: string;
  code?: string;
  message: string;
  param?: string;
  event_id?: string;
};

export type RealtimeServerEvent =
  | { type: "session.created" | "session.updated"; event_id?: string; session: Record<string, any> }
  | { type: "error"; event_id?: string; error: RealtimeErrorDetail }
  | { type: "input_audio_buffer.speech_started"; item_id: string; audio_start_ms?: number }
  | { type: "input_audio_buffer.speech_stopped"; item_id: string; audio_end_ms?: number }
  | { type: "input_audio_buffer.committed"; item_id: string; previous_item_id?: string | null }
  | { type: "conversation.item.input_audio_transcription.delta"; item_id: string; delta: string }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      item_id: string;
      transcript: string;
      /** The vendor's, verbatim: `{ type: "tokens", … }` or `{ type: "duration", seconds }`. */
      usage?: Record<string, any>;
      /** gemi's: a token-billed transcription's usage, mapped (audio tokens in
       *  `audioInputTokens`). Billed apart from `response.done`'s, at the
       *  transcription model's rates. */
      transcriptionUsage?: Usage;
      /** gemi's: a duration-billed transcription's seconds. */
      transcriptionSeconds?: number;
    }
  | { type: "response.created"; response: Record<string, any> }
  | {
      type: "response.output_audio_transcript.delta" | "response.output_text.delta";
      response_id: string;
      item_id: string;
      delta: string;
    }
  | {
      type: "response.output_audio_transcript.done";
      response_id: string;
      item_id: string;
      transcript: string;
    }
  | { type: "response.output_text.done"; response_id: string; item_id: string; text: string }
  | {
      type: "response.function_call_arguments.done";
      response_id: string;
      item_id: string;
      /** The id the `function_call_output` must answer. */
      call_id: string;
      name: string;
      /** JSON, as the model wrote it. Untrusted: parse and validate. */
      arguments: string;
    }
  | {
      type: "response.done";
      response: {
        id: string;
        status: "completed" | "cancelled" | "failed" | "incomplete" | (string & {});
        status_details?: Record<string, any> | null;
        output?: Record<string, any>[];
        usage?: Record<string, any>;
        [key: string]: unknown;
      };
      /** gemi's: the response's usage, mapped. Absent when the vendor sent none. */
      usage?: Usage;
    }
  | { type: "output_audio_buffer.started" | "output_audio_buffer.stopped"; response_id?: string }
  | { type: "sideband.reconnected"; attempt: number }
  | {
      type: "sideband.closed";
      code: number;
      reason: string;
      /** `true` when this side closed it (`close()` / `hangup()`). */
      byClient: boolean;
    };

/** Any event, including ones gemi has no type for. Narrow on `type`. */
export type RealtimeEvent = RealtimeServerEvent | { type: string; [key: string]: unknown };

const RENAMED: Record<string, string> = {
  "response.audio_transcript.delta": "response.output_audio_transcript.delta",
  "response.audio_transcript.done": "response.output_audio_transcript.done",
  "response.text.delta": "response.output_text.delta",
  "response.text.done": "response.output_text.done",
  "response.audio.delta": "response.output_audio.delta",
  "response.audio.done": "response.output_audio.done",
};

/** One frame off the socket onto a `RealtimeEvent`. `undefined` for a frame
 *  that is not a JSON object with a `type`. Exported for tests. */
export function parseRealtimeEvent(data: unknown): RealtimeEvent | undefined {
  if (typeof data !== "string") return undefined;
  let event: any;
  try {
    event = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") return undefined;
  const renamed = RENAMED[event.type];
  if (renamed) event.type = renamed;
  if (event.type === "response.done" && event.response?.usage) {
    event.usage = toRealtimeUsage(event.response.usage);
  }
  if (event.type === "conversation.item.input_audio_transcription.completed" && event.usage) {
    if (event.usage.type === "duration") {
      const seconds = Number(event.usage.seconds);
      if (Number.isFinite(seconds)) event.transcriptionSeconds = seconds;
    } else {
      event.transcriptionUsage = toRealtimeUsage(event.usage);
    }
  }
  return event as RealtimeEvent;
}

// --- client events ---------------------------------------------------------

/** A client event as the vendor documents it. `send` takes any of them. */
export type RealtimeClientEvent = { type: string; [key: string]: unknown };

export type RealtimeResponseOptions = {
  /** Instructions for this response only, e.g. "Say this in one sentence." */
  instructions?: string;
  toolChoice?: "auto" | "none" | "required" | { name: string };
  outputModalities?: ("audio" | "text")[];
  /** `"none"` makes an out-of-band response that is not added to the
   *  conversation. */
  conversation?: "auto" | "none";
  metadata?: Record<string, string>;
  /** Merged into the vendor's `response` object last. */
  vendor?: Record<string, unknown>;
};

// --- the socket ------------------------------------------------------------

/** The part of the WHATWG `WebSocket` the sideband uses. */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void;
};

/** Opens a socket with headers. Bun's `WebSocket` takes `{ headers }` as its
 *  second argument, which is what the default uses. */
export type WebSocketFactory = (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocketLike;

const OPEN = 1;

/** Events kept for an iterator that has not started yet. */
const BACKLOG_LIMIT = 500;

function defaultWebSocket(url: string, init: { headers: Record<string, string> }): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init?: unknown) => WebSocketLike })
    .WebSocket;
  if (!Ctor) throw new Error("No global WebSocket: the realtime sideband needs Bun or Node 22+.");
  return new Ctor(url, { headers: init.headers });
}

export type RealtimeSidebandOptions = {
  /**
   * Re-opening a dropped sideband by `callId`. The call itself survives a lost
   * control socket, but a call nobody is metering is the thing this exists to
   * prevent, so a consumer that gives up should `hangup()`.
   *
   * Only an abnormal close is retried. A normal close (1000) is the vendor
   * saying the call is over.
   */
  reconnect?: { attempts?: number; delayMs?: number };
  webSocket?: WebSocketFactory;
};

type SidebandInit = RealtimeSidebandOptions & {
  callId: string;
  url: string;
  headers: () => Promise<Record<string, string>>;
  hangup: () => Promise<void>;
};

type Subscriber = {
  queue: RealtimeEvent[];
  wake?: () => void;
  done: boolean;
};

export class RealtimeSideband implements AsyncIterable<RealtimeEvent> {
  readonly callId: string;
  /** Resolves when the socket first opens; rejects when it never does. */
  readonly ready: Promise<void>;
  /** Resolves with the final `sideband.closed` event. */
  readonly closed: Promise<Extract<RealtimeServerEvent, { type: "sideband.closed" }>>;

  private readonly init: SidebandInit;
  private socket?: WebSocketLike;
  private finalEvent?: Extract<RealtimeServerEvent, { type: "sideband.closed" }>;
  private outbox: string[] = [];
  private subscribers = new Set<Subscriber>();
  private listeners = new Set<(event: RealtimeEvent) => void>();
  /** Events that arrived before anyone subscribed, handed to the first one. */
  private backlog: RealtimeEvent[] | undefined = [];
  private closing = false;
  private finished = false;
  private everOpened = false;
  private failures = 0;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: (
    event: Extract<RealtimeServerEvent, { type: "sideband.closed" }>,
  ) => void;

  constructor(init: SidebandInit) {
    this.init = init;
    this.callId = init.callId;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A consumer that only iterates must not get an unhandled rejection for a
    // sideband that never opened: it learns from `sideband.closed`.
    this.ready.catch(() => {});
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    void this.open();
  }

  // --- sending -------------------------------------------------------------

  /** Sends a client event; queued while the socket is (re)connecting. */
  send(event: RealtimeClientEvent): void {
    if (this.finished || this.closing) return;
    const data = JSON.stringify(event);
    if (this.socket?.readyState === OPEN) this.socket.send(data);
    else this.outbox.push(data);
  }

  updateSession(session: RealtimeSession): void {
    this.send({ type: "session.update", session: toVendorSession(session) });
  }

  /** Adds an item to the conversation without asking for a response. */
  addItem(item: Record<string, unknown>): void {
    this.send({ type: "conversation.item.create", item });
  }

  /**
   * A quiet note for the voice model (a `system` message): context it can use
   * on its next answer, without making it speak now.
   */
  addNote(text: string): void {
    this.addItem({ type: "message", role: "system", content: [{ type: "input_text", text }] });
  }

  /** Answers a function call. `output` is sent as-is when a string, as JSON
   *  otherwise. Call `createResponse()` after it for the model to speak. */
  functionOutput(callId: string, output: unknown): void {
    this.addItem({
      type: "function_call_output",
      call_id: callId,
      output: typeof output === "string" ? output : JSON.stringify(output),
    });
  }

  createResponse(options: RealtimeResponseOptions = {}): void {
    const response: Record<string, unknown> = {};
    if (options.instructions !== undefined) response.instructions = options.instructions;
    if (options.toolChoice !== undefined) {
      response.tool_choice =
        typeof options.toolChoice === "string"
          ? options.toolChoice
          : { type: "function", name: options.toolChoice.name };
    }
    if (options.outputModalities) response.output_modalities = options.outputModalities;
    if (options.conversation) response.conversation = options.conversation;
    if (options.metadata) response.metadata = options.metadata;
    Object.assign(response, options.vendor);
    this.send(
      Object.keys(response).length
        ? { type: "response.create", response }
        : { type: "response.create" },
    );
  }

  cancelResponse(responseId?: string): void {
    this.send(
      responseId
        ? { type: "response.cancel", response_id: responseId }
        : { type: "response.cancel" },
    );
  }

  // --- receiving -----------------------------------------------------------

  /** Calls `listener` for every event from now on. Returns an unsubscribe. */
  on(listener: (event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Every event, in order, until the sideband closes for good (the last one is
   * `sideband.closed`). Each iterator gets the events from the moment it
   * starts; the first one also gets any that arrived before it.
   */
  [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    const sub: Subscriber = { queue: this.backlog ?? [], done: this.finished };
    this.backlog = undefined;
    this.subscribers.add(sub);
    const next = async (): Promise<IteratorResult<RealtimeEvent>> => {
      for (;;) {
        const event = sub.queue.shift();
        if (event) return { value: event, done: false };
        if (sub.done) {
          this.subscribers.delete(sub);
          return { value: undefined, done: true };
        }
        await new Promise<void>((resolve) => (sub.wake = resolve));
        sub.wake = undefined;
      }
    };
    return {
      next,
      return: async () => {
        sub.done = true;
        sub.queue.length = 0;
        this.subscribers.delete(sub);
        return { value: undefined, done: true };
      },
    };
  }

  // --- ending --------------------------------------------------------------

  /** Closes this side's control socket. The call goes on; another process can
   *  open its own sideband by `callId`. */
  close(code = 1000, reason = "closed"): void {
    if (this.finished || this.closing) return;
    this.closing = true;
    if (this.socket && this.socket.readyState <= OPEN) this.socket.close(code, reason);
    else this.finish(code, reason, true);
  }

  /**
   * Ends the call for everyone, then closes the socket.
   *
   * When the vendor refuses the hangup, the socket stays open and the error is
   * thrown: the call may still be running, and this socket is what meters it.
   * The caller decides whether to retry or to wait for the vendor to close it.
   * A sideband the vendor already closed normally (the call is over) needs no
   * hangup, so its failure is ignored.
   */
  async hangup(): Promise<void> {
    try {
      await this.init.hangup();
    } catch (error) {
      if (this.finalEvent && !this.finalEvent.byClient && this.finalEvent.code === 1000) return;
      throw error;
    }
    this.close(1000, "hangup");
  }

  // --- internals -----------------------------------------------------------

  private async open(): Promise<void> {
    let socket: WebSocketLike;
    try {
      const headers = await this.init.headers();
      if (this.closing) return this.finish(1000, "closed", true);
      socket = (this.init.webSocket ?? defaultWebSocket)(this.init.url, { headers });
    } catch (error) {
      return this.dropped(1006, error instanceof Error ? error.message : String(error), false);
    }
    this.socket = socket;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      const reconnected = this.everOpened;
      this.everOpened = true;
      const attempt = this.failures;
      this.failures = 0;
      for (const data of this.outbox.splice(0)) socket.send(data);
      this.resolveReady();
      if (reconnected) this.emit({ type: "sideband.reconnected", attempt });
    });
    socket.addEventListener("message", (message: { data: unknown }) => {
      const event = parseRealtimeEvent(message.data);
      if (event) this.emit(event);
    });
    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      if (this.socket !== socket) return;
      this.dropped(event.code ?? 1006, event.reason ?? "", opened);
    });
    // `error` is always followed by `close`, which decides what happens.
    socket.addEventListener("error", () => {});
  }

  private dropped(code: number, reason: string, wasOpen: boolean): void {
    this.socket = undefined;
    if (this.closing) return this.finish(code, reason, true);
    const attempts = this.init.reconnect?.attempts ?? 3;
    // 1000 is the vendor ending the call. Anything else, or a socket that never
    // opened, is worth another try by `callId`.
    const retry = (code !== 1000 || !wasOpen) && this.failures < attempts;
    if (!retry) return this.finish(code, reason, false);
    this.failures += 1;
    const delay = (this.init.reconnect?.delayMs ?? 500) * 2 ** (this.failures - 1);
    setTimeout(() => void this.open(), delay);
  }

  private finish(code: number, reason: string, byClient: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.outbox.length = 0;
    const event = { type: "sideband.closed" as const, code, reason, byClient };
    this.finalEvent = event;
    this.emit(event);
    for (const sub of this.subscribers) {
      sub.done = true;
      sub.wake?.();
    }
    if (!this.everOpened)
      this.rejectReady(new Error(`Realtime sideband did not open (${code} ${reason}).`));
    this.resolveClosed(event);
  }

  private emit(event: RealtimeEvent): void {
    if (this.backlog) {
      // Bounded: a consumer that only uses `on()` never drains it.
      this.backlog.push(event);
      if (this.backlog.length > BACKLOG_LIMIT) this.backlog.shift();
    }
    for (const sub of this.subscribers) {
      if (sub.done) continue;
      sub.queue.push(event);
      sub.wake?.();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's bug must not stop the others or the iterator.
      }
    }
  }
}
