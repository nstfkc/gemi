import { isSchema, type JSONSchema, type Schema } from "../Schema";
import type { AgentError, Usage } from "../types";
import type { ProviderTarget } from "./endpoints";
import { normalizeProviderError, ProviderHttpError } from "./errors";
import { requestWithRetry, type FetchLike } from "./http";
import { RealtimeSideband, type RealtimeSidebandOptions, type WebSocketFactory } from "./sideband";

/**
 * Realtime (voice) calls on OpenAI's Realtime API and Azure OpenAI's GA
 * `/openai/v1/realtime` surface (#921).
 *
 * EXPERIMENTAL until a live call has run on Azure and on OpenAI: the request
 * shapes below follow the vendors' documentation and are tested against
 * fixtures only. Names and defaults may change in a minor release.
 *
 * THE SHAPE, and why the server holds every key. The browser makes a WebRTC
 * SDP offer and posts it to the app's own route. The route posts that offer,
 * together with the session config (model, instructions, tools, voice, turn
 * detection, transcription), to `/realtime/calls` with the **server's**
 * credential, and hands back the vendor's SDP answer. So no key or ephemeral
 * secret reaches the browser, and the browser does not choose the model or the
 * prompt when the call starts. It can still read the session (the data channel
 * delivers `session.created` with the instructions and tool schemas) and send
 * its own `session.update` / `response.create`, so instructions must hold no
 * secrets, and metering on the sideband, not the prompt, is what bounds a
 * misbehaving client. The server then opens the call's sideband —
 * `wss://…/realtime?call_id=…` — and that is where tool calls run and usage
 * arrives, which is why metering never has to trust the browser.
 *
 * WHAT THIS FILE IS VERIFIED AGAINST. The documented protocol only, through
 * recorded fixtures; there was no Azure realtime deployment to measure when it
 * was written, and no live key was used. `providers/__fixtures__/realtime-*`
 * hold the request and response shapes the tests assert. When a deployment
 * exists, the measurements belong in this comment, as they are on `azureBase`.
 *
 *   POST {base}/realtime/calls                 multipart: sdp, session (JSON)
 *        → 201, body: the SDP answer, `Location: …/realtime/calls/{call_id}`
 *        (the "unified" flow: OpenAI's documented server-side shape)
 *   POST {base}/realtime/calls                 application/sdp: the raw offer,
 *        `Authorization: Bearer <ephemeral secret>` → 201 + `Location`
 *        (the "ephemeral" flow: Azure's documented server-proxied shape; the
 *        session goes into the client secret, minted server-side first)
 *   POST {base}/realtime/client_secrets        { expires_after, session }
 *        → { value, expires_at, session }
 *   POST {base}/realtime/calls/{call_id}/hangup
 *   WSS  {base}/realtime?call_id={call_id}     the sideband (see `sideband.ts`)
 *
 * `{base}` is `https://api.openai.com/v1` or `https://<resource>/openai/v1`,
 * from `endpoints.ts` like every other call — this file appends paths and
 * nothing else.
 */

/** Call creation is a handshake, not work: a vendor that has not answered an
 *  SDP offer in this long has not started a call worth waiting for. */
export const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;

/** The vendor's documented bounds for an ephemeral secret, and its default. */
export const CLIENT_SECRET_MIN_SECONDS = 10;
export const CLIENT_SECRET_MAX_SECONDS = 7200;
export const CLIENT_SECRET_DEFAULT_SECONDS = 600;

// --- session config --------------------------------------------------------

/** A function the voice model may call. Its arguments arrive on the sideband
 *  as `response.function_call_arguments.done`. */
export type RealtimeTool = {
  name: string;
  description?: string;
  /** A gemi schema (`s.object(...)`) or a plain JSON Schema object. */
  parameters?: Schema<unknown> | JSONSchema | Record<string, unknown>;
};

export type RealtimeTurnDetection =
  | {
      type: "semantic_vad";
      eagerness?: "low" | "medium" | "high" | "auto";
      createResponse?: boolean;
      interruptResponse?: boolean;
    }
  | {
      type: "server_vad";
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
      idleTimeoutMs?: number;
      createResponse?: boolean;
      interruptResponse?: boolean;
    };

/**
 * A realtime session, in gemi's names. Mapped onto the vendor's GA `session`
 * object (`type: "realtime"`, `audio.input`, `audio.output`, …) by
 * `toVendorSession`.
 *
 * Only the fields an app is likely to set are named. `vendor` is merged into
 * the vendor object last, for anything else the vendor adds, so a new field
 * does not need a gemi release.
 */
export type RealtimeSession = {
  /** Defaults to the provider's model (the deployment, on Azure). */
  model?: string;
  instructions?: string;
  voice?: string;
  /** `["audio"]` by default on the vendor's side. */
  outputModalities?: ("audio" | "text")[];
  tools?: RealtimeTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** `null` turns voice activity detection off, for push-to-talk: the client
   *  then commits the input buffer itself. */
  turnDetection?: RealtimeTurnDetection | null;
  /** Transcribe what the user says, so captions and transcripts exist. */
  transcription?: { model: string; language?: string; prompt?: string } | null;
  noiseReduction?: "near_field" | "far_field" | null;
  speed?: number;
  maxOutputTokens?: number | "inf";
  /** e.g. `"auto"`, or the vendor's retention-ratio object. */
  truncation?: "auto" | "disabled" | Record<string, unknown>;
  /** Merged into the vendor's session object last. */
  vendor?: Record<string, unknown>;
};

function toolParameters(parameters: RealtimeTool["parameters"]): unknown {
  if (!parameters) return { type: "object", properties: {} };
  return isSchema(parameters) ? parameters.toJSONSchema() : parameters;
}

/**
 * gemi's session onto the vendor's.
 *
 * `model` is written only when there is one: a `session.update` on a live call
 * must not try to change the model, and `createCall` always passes the
 * provider's.
 */
export function toVendorSession(session: RealtimeSession, model?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "realtime" };
  const resolvedModel = session.model ?? model;
  if (resolvedModel) out.model = resolvedModel;
  if (session.instructions !== undefined) out.instructions = session.instructions;
  if (session.outputModalities) out.output_modalities = session.outputModalities;
  if (session.maxOutputTokens !== undefined) out.max_output_tokens = session.maxOutputTokens;
  if (session.truncation !== undefined) out.truncation = session.truncation;

  if (session.tools) {
    out.tools = session.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: toolParameters(tool.parameters),
    }));
  }
  if (session.toolChoice !== undefined) {
    out.tool_choice =
      typeof session.toolChoice === "string"
        ? session.toolChoice
        : { type: "function", name: session.toolChoice.name };
  }

  const input: Record<string, unknown> = {};
  if (session.turnDetection !== undefined) {
    input.turn_detection = session.turnDetection && vendorTurnDetection(session.turnDetection);
  }
  if (session.transcription !== undefined) input.transcription = session.transcription;
  if (session.noiseReduction !== undefined) {
    input.noise_reduction = session.noiseReduction && { type: session.noiseReduction };
  }
  const output: Record<string, unknown> = {};
  if (session.voice !== undefined) output.voice = session.voice;
  if (session.speed !== undefined) output.speed = session.speed;
  if (Object.keys(input).length || Object.keys(output).length) {
    out.audio = {
      ...(Object.keys(input).length ? { input } : {}),
      ...(Object.keys(output).length ? { output } : {}),
    };
  }

  return { ...out, ...session.vendor };
}

function vendorTurnDetection(td: RealtimeTurnDetection): Record<string, unknown> {
  const out: Record<string, unknown> = { type: td.type };
  if (td.createResponse !== undefined) out.create_response = td.createResponse;
  if (td.interruptResponse !== undefined) out.interrupt_response = td.interruptResponse;
  if (td.type === "semantic_vad") {
    if (td.eagerness !== undefined) out.eagerness = td.eagerness;
  } else {
    if (td.threshold !== undefined) out.threshold = td.threshold;
    if (td.prefixPaddingMs !== undefined) out.prefix_padding_ms = td.prefixPaddingMs;
    if (td.silenceDurationMs !== undefined) out.silence_duration_ms = td.silenceDurationMs;
    if (td.idleTimeoutMs !== undefined) out.idle_timeout_ms = td.idleTimeoutMs;
  }
  return out;
}

// --- usage -----------------------------------------------------------------

/**
 * A realtime `response.done`'s `usage` onto gemi's.
 *
 * Its own mapper for the reason `toImageUsage` is: the totals share names with
 * the Responses API's, the details do not. Realtime documents
 * `input_token_details` / `output_token_details` (no `s`), with `audio_tokens`,
 * `text_tokens`, `cached_tokens` and a `cached_tokens_details` split. Both
 * spellings are read, because the Responses API's `input_tokens_details` is one
 * typo away and a vendor normalizing later must not zero the audio share.
 */
export function toRealtimeUsage(raw: any): Usage {
  const inputTokens = Number(raw?.input_tokens ?? 0);
  const outputTokens = Number(raw?.output_tokens ?? 0);
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: Number(raw?.total_tokens ?? inputTokens + outputTokens),
  };
  const input = raw?.input_token_details ?? raw?.input_tokens_details;
  const output = raw?.output_token_details ?? raw?.output_tokens_details;
  if (typeof input?.cached_tokens === "number") usage.cachedInputTokens = input.cached_tokens;
  if (typeof input?.audio_tokens === "number") usage.audioInputTokens = input.audio_tokens;
  const cachedAudio = input?.cached_tokens_details?.audio_tokens;
  if (typeof cachedAudio === "number") usage.cachedAudioInputTokens = cachedAudio;
  if (typeof input?.image_tokens === "number" && input.image_tokens > 0) {
    usage.imageInputTokens = input.image_tokens;
  }
  if (typeof output?.audio_tokens === "number") usage.audioOutputTokens = output.audio_tokens;
  return usage;
}

// --- errors ----------------------------------------------------------------

/**
 * What a realtime HTTP call failed with, as a normalized code. A promise has
 * nowhere else to put it — the same reasoning as `ImageRequestError`, and the
 * vendor's body is on `cause` rather than in `message` for the same reason.
 */
export class RealtimeRequestError extends Error {
  readonly code: AgentError["code"];
  readonly retryable: boolean;
  /** The HTTP status, when the vendor answered one. */
  readonly status?: number;

  constructor(error: AgentError, options: { cause?: unknown; status?: number } = {}) {
    super(error.message, { cause: options.cause });
    this.name = "RealtimeRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
    if (options.status !== undefined) this.status = options.status;
  }
}

// --- the client ------------------------------------------------------------

/**
 * How `createCall` talks to the vendor. Both run server-side, and neither hands
 * the browser a credential.
 *
 * - `"unified"`: one multipart POST (`sdp` + `session`) with the server's key.
 *   OpenAI documents this one.
 * - `"ephemeral"`: mint a short-lived client secret carrying the session, then
 *   POST the raw SDP (`application/sdp`) with that secret as the Bearer. Azure
 *   documents this one ("Azure OpenAI expects application/sdp, not form
 *   data"), so it is Azure's default. The secret is used once, by the server,
 *   and dropped.
 */
export type RealtimeCallFlow = "unified" | "ephemeral";

/** How long the secret behind an `"ephemeral"` call lives: it only has to
 *  outlast one POST. The vendor's minimum is 10 s. */
const EPHEMERAL_CALL_SECRET_SECONDS = 60;

export type CreateCallParams = {
  /** The browser's SDP offer, verbatim. */
  sdp: string;
  /** Overrides the client's flow for this call. */
  flow?: RealtimeCallFlow;
  /**
   * Azure only: `?webrtcfilter=on`, which limits what the browser's data
   * channel receives (no instructions, no function calls, no `response.done`).
   * Keeps the prompt private, but the browser then cannot show "working" from
   * the events alone.
   */
  webrtcFilter?: boolean;
  session?: RealtimeSession;
  /**
   * A stable, non-identifying id for the end user (e.g. a hash of their id),
   * sent as `OpenAI-Safety-Identifier` so abuse is attributed to a user and not
   * to the whole app.
   */
  safetyIdentifier?: string;
  signal?: AbortSignal;
};

export type CreateCallResult = {
  /** Hand this back to the browser for `setRemoteDescription`. */
  sdpAnswer: string;
  /** The call's id, for the sideband and for `hangup`. */
  callId: string;
};

export type ClientSecretParams = {
  session?: RealtimeSession;
  /** 10–7200, default 600. */
  ttlSeconds?: number;
  signal?: AbortSignal;
};

export type ClientSecret = {
  value: string;
  /** Unix seconds. */
  expiresAt: number;
  /** The session the vendor resolved, verbatim. */
  session: unknown;
};

export type RealtimeClientOptions = {
  /** The model a call uses when its session names none. The deployment, on Azure. */
  model: string;
  /** `"unified"` by default; `AzureOpenAIProvider` passes `"ephemeral"`. See
   *  `RealtimeCallFlow`. */
  callFlow?: RealtimeCallFlow;
  /** Injected by tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected by tests. Defaults to the global `WebSocket` (Bun's, which takes
   *  `headers`). */
  webSocket?: WebSocketFactory;
};

/**
 * The realtime surface of one provider. `OpenAIProvider#realtime` and
 * `AzureOpenAIProvider#realtime` return one of these, built on the provider's
 * resolved `ProviderTarget`, so the host, the credential and Azure's `/openai`
 * handling come from `endpoints.ts`.
 *
 * @experimental Not yet verified against a live Azure or OpenAI call.
 */
export class RealtimeClient {
  readonly model: string;
  private readonly target: ProviderTarget;
  private readonly options: RealtimeClientOptions;

  constructor(target: ProviderTarget, options: RealtimeClientOptions) {
    this.target = target;
    this.options = options;
    this.model = options.model;
  }

  /** `https://…/v1/realtime/calls` etc. Exposed for logs and tests. */
  url(path: string): string {
    return `${this.target.base}/realtime${path}${this.target.query}`;
  }

  /** The sideband's URL for a call: the HTTP base with a `wss` scheme. */
  sidebandUrl(callId: string): string {
    const base = this.target.base.replace(/^http(s?):/i, (_m, s) => `ws${s}:`);
    const query = this.target.query ? `${this.target.query}&` : "?";
    return `${base}/realtime${query}call_id=${encodeURIComponent(callId)}`;
  }

  /**
   * Starts a WebRTC call from the browser's SDP offer, server-side.
   *
   * Not retried on a timeout: a call the vendor created and we hung up on is
   * not one the browser can join, and a second offer starts a second call.
   * A 429 or 5xx is retried, since those say no call was made.
   */
  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    const flow = params.flow ?? this.options.callFlow ?? "unified";
    let headers: Record<string, string>;
    let body: BodyInit;
    if (flow === "ephemeral") {
      const secret = await this.clientSecret({
        session: params.session,
        ttlSeconds: EPHEMERAL_CALL_SECRET_SECONDS,
        signal: params.signal,
      });
      headers = { authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" };
      body = params.sdp;
    } else {
      const form = new FormData();
      form.set("sdp", params.sdp);
      form.set("session", JSON.stringify(toVendorSession(params.session ?? {}, this.model)));
      headers = await this.target.headers();
      body = form;
    }
    if (params.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = params.safetyIdentifier;

    const url = this.url("/calls");
    const response = await this.request(
      params.webrtcFilter ? `${url}${url.includes("?") ? "&" : "?"}webrtcfilter=on` : url,
      { method: "POST", headers, body },
      params.signal,
    );
    const sdpAnswer = await response.text();
    const callId = callIdFrom(response);
    if (!callId) {
      throw new RealtimeRequestError({
        code: "provider_error",
        message: "The provider started a realtime call but did not say which one (no Location).",
        retryable: false,
      });
    }
    return { sdpAnswer, callId };
  }

  /**
   * An ephemeral secret for apps that let the browser connect on its own. The
   * browser then receives the function calls, and its reported usage is not
   * something to bill from — prefer `createCall` plus the sideband.
   */
  async clientSecret(params: ClientSecretParams = {}): Promise<ClientSecret> {
    const seconds = params.ttlSeconds ?? CLIENT_SECRET_DEFAULT_SECONDS;
    if (
      !Number.isInteger(seconds) ||
      seconds < CLIENT_SECRET_MIN_SECONDS ||
      seconds > CLIENT_SECRET_MAX_SECONDS
    ) {
      throw new RangeError(
        `ttlSeconds must be a whole number from ${CLIENT_SECRET_MIN_SECONDS} to ${CLIENT_SECRET_MAX_SECONDS}, got ${seconds}.`,
      );
    }
    const headers = { ...(await this.target.headers()), "content-type": "application/json" };
    const response = await this.request(
      this.url("/client_secrets"),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds },
          session: toVendorSession(params.session ?? {}, this.model),
        }),
      },
      params.signal,
    );
    const json: any = await response.json();
    if (typeof json?.value !== "string") {
      throw new RealtimeRequestError({
        code: "provider_error",
        message: "The provider answered a client secret request with no secret.",
        retryable: false,
      });
    }
    return { value: json.value, expiresAt: Number(json.expires_at ?? 0), session: json.session };
  }

  /**
   * Ends a call for everyone: the browser's peer connection closes and so does
   * any sideband.
   *
   * A 404 counts as "already over" only when its body says the *call* was not
   * found. Any other 404 — a route the vendor does not have (Azure does not
   * document `/hangup`), a wrong deployment — throws, because treating it as
   * success would let the caller drop the sideband, the only thing metering
   * the call, while the call goes on.
   */
  async hangup(callId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.request(
        this.url(`/calls/${encodeURIComponent(callId)}/hangup`),
        { method: "POST", headers: await this.target.headers() },
        options.signal,
      );
    } catch (error) {
      if (isCallNotFound(error, callId)) return;
      throw error;
    }
  }

  /**
   * The call's server-side control channel. Opens at once; events sent before
   * it is open are queued. See `RealtimeSideband`.
   */
  sideband(callId: string, options: RealtimeSidebandOptions = {}): RealtimeSideband {
    return new RealtimeSideband({
      ...options,
      callId,
      url: this.sidebandUrl(callId),
      headers: this.target.headers,
      webSocket: options.webSocket ?? this.options.webSocket,
      hangup: () => this.hangup(callId),
    });
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await requestWithRetry(url, init, {
        maxRetries: this.target.maxRetries,
        timeoutMs: this.target.timeoutMs,
        retryTimeouts: false,
        signal,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RealtimeRequestError(normalizeProviderError(error), {
        cause: error,
        ...(error instanceof ProviderHttpError ? { status: error.status } : {}),
      });
    }
  }
}

/**
 * A hangup's 404 that names the call, not the route: an error body whose code
 * or message is about the call (or its id). A bare 404, or "Resource not
 * found", is a route the vendor does not serve.
 */
export function isCallNotFound(error: unknown, callId: string): boolean {
  if (!(error instanceof RealtimeRequestError) || error.status !== 404) return false;
  const body: any = error.cause instanceof ProviderHttpError ? error.cause.body : undefined;
  const detail = body?.error ?? body;
  const code = String(detail?.code ?? "").toLowerCase();
  const message = String(detail?.message ?? "").toLowerCase();
  if (code.includes("call")) return true;
  if (message.includes(callId.toLowerCase())) return true;
  return /\bcall\b/.test(message) && /not (be )?found|does not exist|no longer|ended/.test(message);
}

/** `Location: /v1/realtime/calls/rtc_123` → `rtc_123`. */
function callIdFrom(response: Response): string | undefined {
  const location = response.headers.get("location");
  if (!location) return undefined;
  const path = location.split("?")[0]!.replace(/\/+$/, "");
  const id = path.slice(path.lastIndexOf("/") + 1);
  return id ? decodeURIComponent(id) : undefined;
}
