import type { AgentTurn, AgentTurnParams } from "./AgentController";
import type { RealtimeClient, RealtimeSession, RealtimeTool } from "./providers/realtime";
import type { RealtimeEvent, RealtimeSideband } from "./providers/sideband";
import { addUsage, emptyUsage } from "./runtime";
import type {
  AgentStreamEvent,
  ClientToolResult,
  ClientTurn,
  PendingToolCall,
  Usage,
} from "./types";
import type { VoiceSessionStore } from "./voiceStore";
import type { VoiceEndReason } from "./voice/wire";

/**
 * A voice front for an `AgentController` (#921).
 *
 * @experimental Not yet verified against a live Azure or OpenAI call; names and
 * behaviour may change in a minor release.
 *
 * THE SHAPE. A realtime voice model talks to the user; the agent the app
 * already has does the work. The voice model gets one delegate tool
 * (`ask_agent({ request })` by default) and three small ones (`stop_work`,
 * `work_status`, `answer_question`). This class runs on the call's sideband,
 * where those function calls arrive, and turns a delegated request into
 * `controller.startTurn(...)` — so the work goes through the controller's
 * `authorizeRequest`, `runOwner`, `context()`, limits, hooks, tools and store,
 * exactly like a typed message, and lands on the same thread the chat shows.
 *
 * WHY NOT GIVE THE VOICE MODEL THE AGENT'S TOOLS. A real agent has dozens of
 * tools, deferred namespaces and prompts tuned for its own model; a realtime
 * model is weaker at long tool chains and re-bills every tool schema on every
 * response; and real work takes minutes, which a voice cannot block on.
 * Delegation keeps one source of truth for what the agent can do.
 *
 * WHAT IT DOES WHILE A TURN RUNS:
 *
 * - The turn's tool calls (or the app's `progress` summary of its events) go
 *   into the voice conversation as quiet notes, at most one per
 *   `progressIntervalMs`, so the voice can say where the work is when asked.
 * - When the turn ends, its text goes back as the delegate call's
 *   `function_call_output`, and the voice is asked to respond, so it speaks the
 *   outcome. A turn that ends `awaiting-input` hands its questions to the voice;
 *   the spoken answer comes back through `answer_question` as
 *   `startTurn({ turn: { toolResults } })`.
 * - One turn at a time. A second request is queued (up to `maxQueued`) and
 *   answered at once with `queued`, so the voice can say "after this one"; a run
 *   already going on the thread (a typed message) is waited for, and looked
 *   for again right before `startTurn`. `liveRuns` is per process, so a run on
 *   another instance is not seen, and a typed message that starts in the
 *   instant between that last look and `startTurn` is superseded, as two typed
 *   messages would be.
 * - Delegated turns run as the `user` captured when the call started, for the
 *   whole call. A sign-out mid-call is seen only when `authorizeRequest`
 *   refuses a turn.
 * - Barge-in stays the vendor's (server VAD cancels the spoken response) and
 *   never stops the work. Only `stop_work` does.
 *
 * Ending the call does not stop a running turn: the turn is the thread's, and
 * the chat shows how it ends.
 */

// --- public types ----------------------------------------------------------

/** What the bridge needs of a controller: its `startTurn`. Pass the class. */
export type VoiceTurnController<Body extends object> = {
  startTurn(params: AgentTurnParams<Body>): Promise<AgentTurn>;
};

/** Where the bridge looks for a run already going on the thread. An
 *  `AgentController`'s `liveRuns`. */
export type VoiceLiveRuns = {
  find(params: { threadId: string }): Promise<{ runId: string } | null>;
  get(runId: string): { result(): Promise<unknown> } | null;
};

export type VoiceLimits = {
  /** The call is ended after this long. Default 15 minutes. */
  maxDurationMs?: number;
  /** Ended after this long with nobody speaking and no work running.
   *  Default 2 minutes. */
  idleTimeoutMs?: number;
  /** Requests waiting behind the running one. Default 3. */
  maxQueued?: number;
  /** At most one progress note per this long. Default 4 seconds. */
  progressIntervalMs?: number;
  /** How long a closing line may play before the call is hung up. Default 10 s. */
  closingLineMs?: number;
  /** How often `onTick` is called. Default one minute. */
  tickMs?: number;
  /** When the vendor refuses the hangup, how long the sideband is kept open
   *  (still metering) waiting for the vendor to end the call. Default 30 s. */
  hangupGraceMs?: number;
};

/** Lines the voice says before the bridge hangs up. `null` hangs up silently. */
export type VoiceLines = {
  maxDuration?: string | null;
  idle?: string | null;
  error?: string | null;
};

export type VoiceDelegate = {
  /** The delegate tool's name. Default `ask_agent`. */
  name?: string;
  /** What the voice model is told the tool does. */
  description?: string;
};

export type VoiceUsageInfo = {
  sessionId: string;
  /** Usage so far, this response included. */
  total: Usage;
  /** Since the bridge started. */
  elapsedMs: number;
  /** Transcription so far: billed apart from `total`, at the transcription
   *  model's rates. */
  transcription: VoiceTranscriptionUsage;
};

/** Input transcription's usage: tokens for a token-billed model, seconds for a
 *  duration-billed one. */
export type VoiceTranscriptionUsage = { usage: Usage; seconds: number };

export type VoiceTranscriptLine = { role: "user" | "assistant"; text: string; at: number };

/** One delegated request and how it went. */
export type VoiceRequestRecord = {
  request: string;
  status: "queued" | "running" | "done" | "refused" | "dropped";
  runId?: string;
  finishReason?: string;
};

export type VoiceSummary = {
  sessionId: string;
  callId?: string;
  threadId: string;
  reason: VoiceEndReason;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** Whole seconds, rounded up: what a per-second or per-minute price reads. */
  seconds: number;
  /** The voice model's responses (`response.done`). */
  usage: Usage;
  /** Input transcription, billed separately from `usage`. */
  transcription: VoiceTranscriptionUsage;
  /** What was said, from the vendor's transcripts. The app decides what to keep. */
  transcript: VoiceTranscriptLine[];
  requests: VoiceRequestRecord[];
  /** `error` events the vendor sent, in order. */
  errors: { code?: string; message: string }[];
};

/**
 * Thrown from `onUsage` or `onTick` to end the call: out of credits, a daily
 * cap. `line` is said first ("You're out of credits; buy a pack to keep
 * talking."), then the call is hung up with reason `usage`.
 */
export class VoiceHangup extends Error {
  readonly line?: string;

  constructor(line?: string) {
    super(line ?? "Voice session ended by the app.");
    this.name = "VoiceHangup";
    this.line = line;
  }
}

export type VoiceBridgeParams<Body extends object = Record<string, unknown>> = {
  controller: VoiceTurnController<Body>;
  threadId: string;
  /** Who delegated turns run as: `startTurn`'s `user`. */
  user?: unknown;
  body?: Body;
  /** The call: a provider's realtime client and the call id, or a sideband
   *  already open (tests, or an app that opened its own). */
  call:
    | { realtime: RealtimeClient; callId: string }
    | { sideband: RealtimeSideband; callId?: string };
  /** Default: a random id. The `VoiceSessionRecord`'s id when there is a store. */
  sessionId?: string;
  /** When set, the latest `body` is read from here before every delegated
   *  turn, and the end is recorded. */
  store?: VoiceSessionStore;
  /** Runs already going on the thread are waited for. An `AgentController`'s
   *  `liveRuns`. */
  liveRuns?: VoiceLiveRuns;
  delegate?: VoiceDelegate;
  limits?: VoiceLimits;
  lines?: VoiceLines;
  /** The session the call was created with. A `session.updated` whose
   *  instructions or tool names differ from it ends the call (a client can send
   *  `session.update` on the data channel). */
  session?: RealtimeSession;
  /** A one-line summary of a run event for a progress note, or nothing. The
   *  default names each tool call and reads a string (or `message`) a tool
   *  yields. */
  progress?: (event: AgentStreamEvent) => string | null | undefined;
  /** A note for the voice when `setBody` changes the body ("The user selected
   *  the hero section."). */
  contextNote?: (body: Body) => string | null | undefined;
  /** After each response, with its usage. Throw `VoiceHangup` to end the call.
   *  Hooks run in order, off the event loop: a slow one does not delay the
   *  call's tool handling. */
  onUsage?: (usage: Usage, info: VoiceUsageInfo) => void | Promise<void>;
  /** After each transcribed utterance, with its usage (`usage` for a
   *  token-billed model, `seconds` for a duration-billed one). Throw
   *  `VoiceHangup` to end the call. */
  onTranscriptionUsage?: (
    usage: { usage?: Usage; seconds?: number },
    info: VoiceUsageInfo,
  ) => void | Promise<void>;
  /** Every `tickMs`, for time-based metering. Throw `VoiceHangup` to end the call. */
  onTick?: (info: VoiceUsageInfo) => void | Promise<void>;
  /** Once, when the call has ended. */
  onEnd?: (summary: VoiceSummary) => void | Promise<void>;
  /** Every sideband event, for logs. */
  onEvent?: (event: RealtimeEvent) => void;
};

export const DEFAULT_DELEGATE_NAME = "ask_agent";

const DEFAULT_LIMITS = {
  maxDurationMs: 15 * 60_000,
  idleTimeoutMs: 2 * 60_000,
  maxQueued: 3,
  progressIntervalMs: 4_000,
  closingLineMs: 10_000,
  tickMs: 60_000,
  hangupGraceMs: 30_000,
} satisfies Required<VoiceLimits>;

const DEFAULT_LINES = {
  maxDuration:
    "We've reached the time limit for this voice session. Tap the microphone to start again.",
  idle: "It's gone quiet, so I'll hang up. Tap the microphone when you want to talk again.",
  error: null,
} satisfies Required<VoiceLines>;

/**
 * The tools the voice model is given, for its session. `createCall` needs them
 * in `session.tools`; `this.voice()` adds them itself.
 */
export function voiceTools(delegate: VoiceDelegate = {}): RealtimeTool[] {
  return [
    {
      name: delegate.name ?? DEFAULT_DELEGATE_NAME,
      description:
        delegate.description ??
        "Hand one self-contained request to the agent that does the work, in the user's own words with references resolved. It can take minutes; the result comes back when it is done, so tell the user you are on it.",
      parameters: {
        type: "object",
        properties: { request: { type: "string", description: "What the user wants done." } },
        required: ["request"],
        additionalProperties: false,
      },
    },
    {
      name: "stop_work",
      description: "Stop the work that is running, and drop any requests waiting behind it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "work_status",
      description: "What the agent is doing right now, and what is waiting.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "answer_question",
      description:
        "Answer the question the agent asked (it came back from a request with status needs_input). For an approval, set approve.",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string", description: "The user's answer, in their words." },
          approve: { type: "boolean", description: "For an approval: whether the user approved." },
        },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  ];
}

// --- the bridge ------------------------------------------------------------

type Job = {
  record: VoiceRequestRecord;
  turn: ClientTurn;
  /** The function call to answer when the job ends; `undefined` once answered. */
  callId?: string;
  handle?: AgentTurn;
  /** `stop_work` arrived before the turn started: it is not started. */
  stopRequested?: boolean;
};

/** Live bridges in this process, by session id. */
const live = new Map<string, VoiceBridge<any>>();

export class VoiceBridge<Body extends object = Record<string, unknown>> {
  readonly sessionId: string;
  readonly threadId: string;
  readonly callId?: string;
  /** Resolves with the summary once the call has ended and `onEnd` has run. */
  readonly ended: Promise<VoiceSummary>;

  private readonly params: VoiceBridgeParams<Body>;
  private readonly sideband: RealtimeSideband;
  private readonly hangupCall: () => Promise<void>;
  private readonly limits: Required<VoiceLimits>;
  private readonly lines: Required<VoiceLines>;
  private readonly delegateName: string;
  private readonly startedAt = Date.now();

  private body: Body;
  private usage: Usage = emptyUsage();
  private transcription: VoiceTranscriptionUsage = { usage: emptyUsage(), seconds: 0 };
  /** Hooks run one after another, off the event loop. */
  private hooks: Promise<void> = Promise.resolve();
  /** The `event_id` of the bridge's own `response.create` not yet answered. */
  private pendingCreate?: string;
  private transcript: VoiceTranscriptLine[] = [];
  private requests: VoiceRequestRecord[] = [];
  private errors: VoiceSummary["errors"] = [];
  private running?: Job;
  private queue: Job[] = [];
  private pending: PendingToolCall[] = [];
  private lastProgress?: string;
  private lastNoteAt = 0;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private responseActive = false;
  private responseWanted = false;
  private ending?: Promise<VoiceSummary>;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private idleTimer?: ReturnType<typeof setTimeout>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private resolveEnded!: (summary: VoiceSummary) => void;
  private closingWaiter?: (event: RealtimeEvent) => void;

  /** Starts the bridge on a call that has been created. */
  static start<Body extends object>(params: VoiceBridgeParams<Body>): VoiceBridge<Body> {
    return new VoiceBridge(params);
  }

  /** A bridge running in this process, by session id. */
  static get(sessionId: string): VoiceBridge<any> | undefined {
    return live.get(sessionId);
  }

  /** Ends every call this process holds, e.g. on shutdown, with an optional
   *  line ("Voice paused, tap to resume."). */
  static async endAll(line?: string | null): Promise<void> {
    await Promise.all([...live.values()].map((bridge) => bridge.end("hangup", line)));
  }

  private constructor(params: VoiceBridgeParams<Body>) {
    this.params = params;
    this.sessionId = params.sessionId ?? crypto.randomUUID();
    this.threadId = params.threadId;
    this.body = (params.body ?? {}) as Body;
    this.limits = { ...DEFAULT_LIMITS, ...definedOnly(params.limits) };
    this.lines = { ...DEFAULT_LINES, ...definedOnly(params.lines) };
    this.delegateName = params.delegate?.name ?? DEFAULT_DELEGATE_NAME;

    if ("realtime" in params.call) {
      const { realtime, callId } = params.call;
      this.callId = callId;
      this.sideband = realtime.sideband(callId);
      this.hangupCall = () => this.sideband.hangup();
    } else {
      this.callId = params.call.callId ?? params.call.sideband.callId;
      this.sideband = params.call.sideband;
      this.hangupCall = () => this.sideband.hangup();
    }

    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    live.set(this.sessionId, this);

    this.timers.push(
      setTimeout(
        () => void this.end("max_duration", this.lines.maxDuration),
        this.limits.maxDurationMs,
      ),
    );
    this.tickTimer = setInterval(() => void this.tick(), this.limits.tickMs);
    this.touch();
    void this.listen();
  }

  // --- the app's handles ----------------------------------------------------

  /** The body delegated turns get from now on. Says `contextNote`'s line to
   *  the voice when there is one. */
  setBody(body: Body): void {
    this.body = body;
    const note = this.params.contextNote?.(body);
    if (note) this.sideband.addNote(note);
  }

  /** Ends the call: says `line` first when given, then hangs up. */
  end(reason: VoiceEndReason = "hangup", line?: string | null): Promise<VoiceSummary> {
    return (this.ending ??= this.finish(reason, line ?? null));
  }

  // --- events ---------------------------------------------------------------

  private async listen(): Promise<void> {
    for await (const event of this.sideband) {
      try {
        this.params.onEvent?.(event);
      } catch {
        // A logger's bug must not end the call.
      }
      this.closingWaiter?.(event);
      await this.handle(event);
    }
  }

  private async handle(event: RealtimeEvent): Promise<void> {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.touch();
        return;
      case "response.created":
        this.responseActive = true;
        this.pendingCreate = undefined;
        this.touch();
        return;
      case "response.done": {
        this.responseActive = false;
        if (this.responseWanted && !this.ending) {
          this.responseWanted = false;
          this.createResponse();
        }
        const usage = (event as { usage?: Usage }).usage;
        if (usage) {
          this.usage = addUsage(this.usage, usage);
          const info = this.info();
          this.hook(() => this.params.onUsage?.(usage, info));
        }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const done = event as {
          transcript?: unknown;
          transcriptionUsage?: Usage;
          transcriptionSeconds?: number;
        };
        this.say("user", String(done.transcript ?? ""));
        if (done.transcriptionUsage || done.transcriptionSeconds !== undefined) {
          this.transcription = {
            usage: done.transcriptionUsage
              ? addUsage(this.transcription.usage, done.transcriptionUsage)
              : this.transcription.usage,
            seconds: this.transcription.seconds + (done.transcriptionSeconds ?? 0),
          };
          const info = this.info();
          const usage = {
            ...(done.transcriptionUsage ? { usage: done.transcriptionUsage } : {}),
            ...(done.transcriptionSeconds !== undefined
              ? { seconds: done.transcriptionSeconds }
              : {}),
          };
          this.hook(() => this.params.onTranscriptionUsage?.(usage, info));
        }
        return;
      }
      case "response.output_audio_transcript.done":
        this.say("assistant", String((event as { transcript?: unknown }).transcript ?? ""));
        return;
      case "response.output_text.done":
        this.say("assistant", String((event as { text?: unknown }).text ?? ""));
        return;
      case "response.function_call_arguments.done": {
        const call = event as { call_id: string; name: string; arguments: string };
        this.touch();
        if (!this.ending) this.call(call.call_id, call.name, call.arguments);
        return;
      }
      case "session.updated":
        if (this.tampered((event as { session?: Record<string, any> }).session)) {
          void this.end("session_tampered", null);
        }
        return;
      case "error": {
        const error = (event as { error?: { code?: string; message?: string; event_id?: string } })
          .error;
        this.errors.push({ code: error?.code, message: String(error?.message ?? "") });
        // The vendor refused the bridge's own `response.create`: no response
        // will start, so stop waiting for one — or, when one is already
        // running, ask again once it is done.
        if (this.pendingCreate && error?.event_id === this.pendingCreate) {
          this.pendingCreate = undefined;
          if (error.code === "conversation_already_has_active_response") {
            this.responseActive = true;
            this.responseWanted = true;
          } else {
            this.responseActive = false;
          }
        }
        return;
      }
      case "sideband.closed": {
        const closed = event as { code: number; byClient: boolean };
        if (!this.ending && !closed.byClient) {
          void this.end(closed.code === 1000 ? "call_ended" : "sideband_lost", null);
        }
        return;
      }
    }
  }

  private say(role: "user" | "assistant", text: string): void {
    if (text.trim()) this.transcript.push({ role, text, at: Date.now() });
  }

  // --- the tools ------------------------------------------------------------

  private call(callId: string, name: string, rawArgs: string): void {
    const args = parseArgs(rawArgs);
    if (name === this.delegateName) {
      const request = typeof args.request === "string" ? args.request.trim() : "";
      if (!request)
        return this.answer(callId, { status: "error", message: "The request was empty." });
      return this.enqueue({
        record: { request, status: "queued" },
        turn: { text: request },
        callId,
      });
    }
    switch (name) {
      case "stop_work": {
        const running = this.running;
        if (running) {
          running.stopRequested = true;
          running.handle?.stop({ reason: "Stopped by voice." });
        }
        const dropped = this.dropQueue();
        return this.answer(callId, { stopped: Boolean(running), dropped });
      }
      case "work_status":
        return this.answer(callId, {
          running: this.running
            ? { request: this.running.record.request, step: this.lastProgress ?? "starting" }
            : null,
          queued: this.queue.map((job) => job.record.request),
          ...(this.pending.length ? { needsInput: this.questions() } : {}),
        });
      case "answer_question": {
        if (!this.pending.length) {
          return this.answer(callId, { status: "error", message: "There is no open question." });
        }
        const answer = typeof args.answer === "string" ? args.answer : "";
        const approve = typeof args.approve === "boolean" ? args.approve : undefined;
        const toolResults = this.pending.map((call) => toolResult(call, answer, approve));
        this.pending = [];
        return this.enqueue({
          record: { request: `(answer) ${answer}`, status: "queued" },
          turn: { toolResults },
          callId,
        });
      }
      default:
        return this.answer(callId, {
          status: "error",
          message: `There is no tool called ${name}.`,
        });
    }
  }

  private enqueue(job: Job): void {
    if (!this.running) {
      this.requests.push(job.record);
      void this.run(job);
      return;
    }
    if (this.queue.length >= this.limits.maxQueued) {
      return this.answer(job.callId!, {
        status: "busy",
        message: "Too many requests are waiting. Ask the user to wait for the current one.",
      });
    }
    this.requests.push(job.record);
    this.queue.push(job);
    this.answer(job.callId!, {
      status: "queued",
      position: this.queue.length,
      message: "It will start when the current request is done.",
    });
    job.callId = undefined;
  }

  private async run(job: Job): Promise<void> {
    this.running = job;
    job.record.status = "running";
    this.lastProgress = undefined;
    this.pauseIdle();
    try {
      const waited = new Set<string>();
      await this.waitForThread(waited);
      const body = await this.latestBody();
      // Looked for again: a typed message may have started while the body was
      // read. The window left is the one `find` takes.
      while (!job.stopRequested && (await this.waitForThread(waited))) {
        // waited for one more
      }
      if (job.stopRequested || this.ending) {
        job.record.status = "dropped";
        this.complete(job, { status: "stopped" });
        return;
      }
      let turn: AgentTurn;
      try {
        turn = await this.params.controller.startTurn({
          threadId: this.threadId,
          user: this.params.user,
          body,
          turn: job.turn,
        });
      } catch (error) {
        job.record.status = "refused";
        this.complete(job, {
          status: "refused",
          message: error instanceof Error ? error.message : "The request could not be started.",
        });
        return;
      }
      job.handle = turn;
      job.record.runId = turn.runId;
      void this.follow(turn);
      const result = await turn.result();
      job.record.status = "done";
      job.record.finishReason = result.finishReason;
      if (result.finishReason === "awaiting-input" && result.pending.length) {
        this.pending = result.pending;
        this.complete(job, {
          status: "needs_input",
          text: result.text,
          questions: this.questions(),
        });
      } else if (result.finishReason === "error") {
        this.complete(job, {
          status: "failed",
          message: result.error?.message ?? "The work failed.",
        });
      } else if (result.finishReason === "aborted") {
        this.complete(job, { status: "stopped", text: result.text });
      } else {
        this.complete(job, { status: "done", text: result.text });
      }
    } catch (error) {
      job.record.status = "done";
      this.complete(job, {
        status: "failed",
        message: error instanceof Error ? error.message : "The work failed.",
      });
    } finally {
      this.running = undefined;
      this.flushNote();
      const next = this.queue.shift();
      if (next && !this.ending) void this.run(next);
      else this.touch();
    }
  }

  /** A run already going on the thread (a typed message) is waited for, not
   *  superseded. */
  private async waitForThread(waited = new Set<string>()): Promise<boolean> {
    const runs = this.params.liveRuns;
    if (!runs) return false;
    const found = await runs.find({ threadId: this.threadId });
    // A run already waited for counts as over, even if a store still lists it.
    const run = found && !waited.has(found.runId) ? runs.get(found.runId) : null;
    if (!found || !run) return false;
    waited.add(found.runId);
    await run.result().catch(() => undefined);
    return true;
  }

  private async latestBody(): Promise<Body> {
    const store = this.params.store;
    if (!store) return this.body;
    const record = await store.get(this.sessionId).catch(() => null);
    if (record) this.body = record.body as Body;
    return this.body;
  }

  private async follow(turn: AgentTurn): Promise<void> {
    const summarize = this.params.progress ?? defaultProgress();
    try {
      for await (const event of turn.run) {
        const line = summarize(event as AgentStreamEvent);
        if (line) this.note(line);
      }
    } catch {
      // Progress is a courtesy; the result is read separately.
    }
  }

  private complete(job: Job, payload: Record<string, unknown>): void {
    if (this.ending) return;
    if (job.callId) {
      this.sideband.functionOutput(job.callId, payload);
      job.callId = undefined;
    } else {
      this.sideband.addNote(
        `Update on the earlier request "${job.record.request}": ${JSON.stringify(payload)}`,
      );
    }
    this.respond();
  }

  private answer(callId: string, payload: Record<string, unknown>): void {
    this.sideband.functionOutput(callId, payload);
    this.respond();
  }

  /** Asks the voice to speak, once the response in flight (if any) is done:
   *  a second `response.create` while one is active is refused by the vendor. */
  private respond(): void {
    if (this.ending) return;
    if (this.responseActive) {
      this.responseWanted = true;
      return;
    }
    this.responseActive = true;
    this.createResponse();
  }

  /** `response.create` with an `event_id`, so a refusal can be told apart. */
  private createResponse(): void {
    const eventId = `gemi_voice_${crypto.randomUUID()}`;
    this.pendingCreate = eventId;
    this.sideband.send({ type: "response.create", event_id: eventId });
  }

  private questions() {
    return this.pending.map((call) => ({
      kind: call.kind,
      tool: String(call.name),
      input: call.input,
    }));
  }

  private dropQueue(): number {
    const dropped = this.queue.splice(0);
    for (const job of dropped) job.record.status = "dropped";
    return dropped.length;
  }

  // --- progress notes -------------------------------------------------------

  private note(line: string): void {
    if (line === this.lastProgress) return;
    this.lastProgress = line;
    const wait = this.lastNoteAt + this.limits.progressIntervalMs - Date.now();
    if (wait <= 0) return this.flushNote();
    this.noteTimer ??= setTimeout(() => this.flushNote(), wait);
  }

  private flushNote(): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = undefined;
    if (!this.lastProgress || this.ending || !this.running) return;
    this.lastNoteAt = Date.now();
    this.sideband.addNote(`Progress on "${this.running.record.request}": ${this.lastProgress}`);
  }

  // --- limits ---------------------------------------------------------------

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.running || this.ending) return;
    this.idleTimer = setTimeout(
      () => void this.end("idle", this.lines.idle),
      this.limits.idleTimeoutMs,
    );
  }

  private pauseIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private info(): VoiceUsageInfo {
    return {
      sessionId: this.sessionId,
      total: this.usage,
      elapsedMs: Date.now() - this.startedAt,
      transcription: this.transcription,
    };
  }

  private tick(): void {
    if (this.ending) return;
    const info = this.info();
    this.hook(() => this.params.onTick?.(info));
  }

  /** Runs an app hook after the ones before it, without holding up the
   *  sideband's events. */
  private hook(fn: () => void | Promise<void>): void {
    this.hooks = this.hooks.then(async () => {
      try {
        await fn();
      } catch (error) {
        if (error instanceof VoiceHangup) void this.end("usage", error.line ?? null);
        else {
          console.error("[gemi/ai] a voice hook threw; ending the call.", error);
          void this.end("error", this.lines.error);
        }
      }
    });
  }

  private tampered(session: Record<string, any> | undefined): boolean {
    const expected = this.params.session;
    if (!expected || !session) return false;
    if (
      expected.instructions !== undefined &&
      session.instructions !== undefined &&
      session.instructions !== expected.instructions
    ) {
      return true;
    }
    if (Array.isArray(session.tools)) {
      // `expected.tools` already holds the voice tools when the session came
      // from `this.voice()`, and not when an app passed its own: a set either way.
      const want = new Set(
        [...voiceTools(this.params.delegate), ...(expected.tools ?? [])].map((tool) => tool.name),
      );
      const got = new Set(session.tools.map((tool: { name?: unknown }) => String(tool?.name)));
      if (want.size !== got.size || [...want].some((name) => !got.has(name))) return true;
    }
    return false;
  }

  // --- the end --------------------------------------------------------------

  private async finish(reason: VoiceEndReason, line: string | null): Promise<VoiceSummary> {
    for (const timer of this.timers) clearTimeout(timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.noteTimer) clearTimeout(this.noteTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.dropQueue();

    const open = reason !== "call_ended" && reason !== "sideband_lost";
    if (line && open) await this.closingLine(line);
    if (reason !== "call_ended") await this.hangUp();
    else this.sideband.close();
    // Hooks queued before the end (the last response's usage) finish first.
    await this.hooks;

    const endedAt = Date.now();
    const durationMs = endedAt - this.startedAt;
    const summary: VoiceSummary = {
      sessionId: this.sessionId,
      ...(this.callId ? { callId: this.callId } : {}),
      threadId: this.threadId,
      reason,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      seconds: Math.ceil(durationMs / 1000),
      usage: this.usage,
      transcription: this.transcription,
      transcript: this.transcript,
      requests: this.requests,
      errors: this.errors,
    };
    live.delete(this.sessionId);
    await this.params.store
      ?.update(this.sessionId, { endedAt, endReason: reason })
      .catch(() => undefined);
    try {
      await this.params.onEnd?.(summary);
    } catch (error) {
      console.error("[gemi/ai] a voice session's onEnd threw.", error);
    }
    this.resolveEnded(summary);
    return summary;
  }

  /**
   * Hangs the call up. When the vendor refuses, the sideband stays open (it is
   * what meters the call) until the vendor ends the call or `hangupGraceMs`
   * passes, so usage that arrives meanwhile is still counted.
   */
  private async hangUp(): Promise<void> {
    try {
      await this.hangupCall();
    } catch (error) {
      console.error("[gemi/ai] a voice call could not be hung up; waiting for the vendor.", error);
      this.errors.push({
        code: "hangup_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.sideband.closed,
        new Promise((resolve) => (timer = setTimeout(resolve, this.limits.hangupGraceMs))),
      ]);
      clearTimeout(timer);
      this.sideband.close();
    }
  }

  /**
   * Says `line` and waits for it to finish playing, or `closingLineMs`,
   * whichever is first.
   *
   * A response still running is cancelled first, and its own `response.done`
   * is waited for before the line is asked for: a `response.create` sent
   * while one is active is refused, and the cancelled response's audio events
   * must not count as the line's. The line's response is then matched by id:
   * its `response.done`, then `output_audio_buffer.stopped` for it (a
   * WebRTC event; if the sideband does not get it, `closingLineMs` ends the
   * wait).
   */
  private async closingLine(line: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const eventId = `gemi_voice_closing_${crypto.randomUUID()}`;
      const cancelId = `gemi_voice_cancel_${crypto.randomUUID()}`;
      let stage: "cancelling" | "asked" | "playing" = this.responseActive ? "cancelling" : "asked";
      let lineResponse: string | undefined;
      const timer = setTimeout(finish, this.limits.closingLineMs);
      function finish() {
        clearTimeout(timer);
        resolve();
      }
      const ask = () => {
        stage = "asked";
        this.sideband.send({
          type: "response.create",
          event_id: eventId,
          response: {
            instructions: `Say exactly this to the user, and nothing else: "${line}"`,
            tool_choice: "none",
          },
        });
      };
      this.closingWaiter = (event) => {
        const e = event as {
          type: string;
          response?: { id?: string };
          response_id?: string;
          error?: { event_id?: string };
        };
        if (e.type === "sideband.closed") return finish();
        if (stage === "cancelling") {
          // Done (cancelled), or the cancel refused because nothing was active.
          if (
            e.type === "response.done" ||
            (e.type === "error" && e.error?.event_id === cancelId)
          ) {
            ask();
          }
          return;
        }
        if (e.type === "error" && e.error?.event_id === eventId) return finish();
        if (e.type === "response.created" && !lineResponse) {
          lineResponse = e.response?.id;
          return;
        }
        const ours = (id?: string) => !lineResponse || !id || id === lineResponse;
        if (e.type === "response.done" && ours(e.response?.id)) stage = "playing";
        else if (
          e.type === "output_audio_buffer.stopped" &&
          stage === "playing" &&
          ours(e.response_id)
        ) {
          finish();
        }
      };
      if (stage === "cancelling")
        this.sideband.send({ type: "response.cancel", event_id: cancelId });
      else ask();
    });
    this.closingWaiter = undefined;
  }
}

// --- helpers ---------------------------------------------------------------

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The spoken answer onto a pending call. A question gets the answer as its
 * output. An approval is approved when `approve` says so, and otherwise denied
 * with the answer as the reason: a voice that did not say "yes" has not
 * approved anything. A client tool cannot run in a voice call, so it is denied.
 */
function toolResult(
  call: PendingToolCall,
  answer: string,
  approve: boolean | undefined,
): ClientToolResult {
  const base = {
    toolCallId: call.toolCallId,
    signature: call.signature,
    ...(call.path ? { path: call.path } : {}),
  };
  if (call.kind === "question") return { ...base, output: answer };
  if (call.kind === "approval") {
    return { ...base, approve: approve === true, ...(answer ? { reason: answer } : {}) };
  }
  return { ...base, approve: false, reason: "Not available in a voice call." };
}

/** Names each tool call once, and reads a string (or `message`, `label`,
 *  `title`) a tool yields. */
function defaultProgress(): (event: AgentStreamEvent) => string | undefined {
  const seen = new Set<string>();
  return (event) => {
    if (event.type === "tool-call") {
      if (event.part.partial || event.resent || seen.has(event.part.toolCallId)) return undefined;
      seen.add(event.part.toolCallId);
      return `running ${String(event.part.name)}`;
    }
    if (event.type === "tool-progress") {
      const data = event.data as unknown;
      if (typeof data === "string") return data;
      if (data && typeof data === "object") {
        for (const key of ["message", "label", "title"] as const) {
          const value = (data as Record<string, unknown>)[key];
          if (typeof value === "string" && value) return value;
        }
      }
    }
    return undefined;
  };
}
