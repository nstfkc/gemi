import { createEnergyVad, rmsOf, type EnergyVadOptions } from "./energyVad";

/**
 * The browser's half of a live transcription session (#929): the microphone,
 * a raw `RTCPeerConnection` to the vendor, the `oai-events` data channel, a
 * level meter and end-of-speech detection that commits each turn.
 *
 * No vendor SDK, and nothing from `gemi/ai`'s server half: the secret (or the
 * SDP answer) comes from the app's own route, which holds the key.
 *
 * @experimental Follows OpenAI's realtime transcription and WebRTC guides; not
 * yet run against a live session.
 */

/** OpenAI's WebRTC endpoint, for a secret whose route doesn't say otherwise.
 *  `clientSecret()` on the server returns `callsUrl` (Azure's host included). */
export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** What the app's token route answers: `realtime.clientSecret(...)`'s result,
 *  or at least its `value`. */
export type LiveTranscriptionToken = {
  value: string;
  /** Where to post the SDP offer. Default OpenAI's. */
  callsUrl?: string;
};

/** A pluggable end-of-speech detector, such as `@ricky0123/vad-web`'s
 *  `MicVAD` on the same stream. Call `speechStart` / `speechEnd` as speech
 *  begins and ends; `speechEnd` commits the turn. */
export type VoiceActivityDetector = (
  stream: MediaStream,
  events: { speechStart(): void; speechEnd(): void },
) => { stop(): void } | Promise<{ stop(): void }>;

export type LiveTranscriptionError = Error & { code?: string; status?: number };

export class LiveTranscriptionFailure extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "LiveTranscriptionError";
    this.code = options.code;
    this.status = options.status;
  }
}

export type LiveTranscriptionConnectOptions = {
  /**
   * `"token"` (default): `source` gives a client secret and the browser posts
   * its SDP to the vendor itself. `"sdp"`: the browser posts `{ sdp, ...body }`
   * to `source` and the route answers `{ sdp }` — the route then creates the
   * call (`realtime.createCall`) and can meter it on the sideband.
   */
  connect?: "token" | "sdp";
  /** The app's route (POSTed `body` as JSON), or a function giving the token. */
  source: string | (() => Promise<LiveTranscriptionToken>);
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** `"energy"` (default): the built-in detector. A function: your own. `false`:
   *  no detection; turns end only on `commit()`. */
  vad?: "energy" | VoiceActivityDetector | false;
  /** The built-in detector's options; `silenceMs` defaults to 350. */
  energy?: EnergyVadOptions;
  /** The vendor's events from the data channel. */
  onEvent(event: { type: string; [key: string]: unknown }): void;
  /** The channel opened: the session is live. */
  onOpen(): void;
  onSpeechStart(): void;
  /** The detector heard the user stop. `committed`: the turn was committed
   *  (there was speech in it and the channel was open). */
  onSpeechEnd(committed: boolean): void;
  /** Microphone level, 0–1, about every 50 ms. */
  onLevel(level: number): void;
  /** Called once when the connection closed or failed. */
  onClose(error?: LiveTranscriptionError): void;
};

export type LiveTranscriptionConnection = {
  /** Sends `input_audio_buffer.commit`. False when the channel isn't open. */
  commit(): boolean;
  /** Commits only if speech was heard since the last commit (always, with no
   *  detector). For a graceful stop. */
  flush(): boolean;
  /** Any client event, e.g. a `session.update` with new keywords. */
  send(event: Record<string, unknown>): boolean;
  /** Pauses the microphone track (nothing is sent while muted). */
  mute(on: boolean): void;
  close(): void;
};

/** How often the level meter (and the built-in detector) reads the mic. */
const FRAME_MS = 30;

function microphoneError(error: unknown): LiveTranscriptionFailure {
  const name = (error as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError"
    ? new LiveTranscriptionFailure("Microphone access was denied.", {
        code: "microphone_denied",
        cause: error,
      })
    : new LiveTranscriptionFailure("No microphone is available.", {
        code: "microphone_unavailable",
        cause: error,
      });
}

async function routeError(response: Response, what: string): Promise<LiveTranscriptionFailure> {
  const body: any = await response.json().catch(() => null);
  return new LiveTranscriptionFailure(body?.error?.message ?? `${what} (${response.status}).`, {
    status: response.status,
    code: body?.error?.code,
  });
}

/**
 * Opens a live transcription session. Resolves once the SDP answer is applied;
 * `onOpen` follows when the data channel opens. `signal` aborts a start in
 * flight (unmount, `stop()` while connecting): everything opened so far is
 * closed and the promise rejects with an `AbortError`.
 */
export async function startLiveTranscription(
  options: LiveTranscriptionConnectOptions,
  signal?: AbortSignal,
): Promise<LiveTranscriptionConnection> {
  if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new LiveTranscriptionFailure("This browser can't stream audio.", { code: "unsupported" });
  }
  const connect = options.connect ?? "token";
  const post = (url: string, payload: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(payload),
      signal,
    });

  // The token and the microphone in parallel: both are on the critical path.
  const tokenPromise: Promise<LiveTranscriptionToken | null> =
    connect === "sdp"
      ? Promise.resolve(null)
      : typeof options.source === "function"
        ? options.source()
        : post(options.source, options.body ?? {}).then(async (response) => {
            if (!response.ok) throw await routeError(response, "Live transcription is unavailable");
            return response.json();
          });
  tokenPromise.catch(() => undefined);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw microphoneError(error);
  }

  const track = stream.getAudioTracks()[0];
  let pc: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let audioContext: AudioContext | undefined;
  let meter: ReturnType<typeof setInterval> | undefined;
  let detector: { stop(): void } | undefined;
  let closed = false;
  /** `onClose` is for a session that started; a failed start throws instead. */
  let started = false;
  /** Speech heard since the last commit: a commit with none is pointless. */
  let heardSpeech = false;

  const close = (error?: LiveTranscriptionFailure) => {
    if (closed) return;
    closed = true;
    if (meter) clearInterval(meter);
    try {
      detector?.stop();
    } catch {
      // a third-party detector failing to stop must not keep the mic open
    }
    try {
      channel?.close();
    } catch {
      // already closed
    }
    pc?.close();
    for (const t of stream.getTracks()) t.stop();
    void audioContext?.close().catch(() => undefined);
    if (started) options.onClose(error);
  };

  const send = (event: Record<string, unknown>) => {
    if (closed || channel?.readyState !== "open") return false;
    channel.send(JSON.stringify(event));
    return true;
  };
  const commit = () => {
    const sent = send({ type: "input_audio_buffer.commit" });
    if (sent) heardSpeech = false;
    return sent;
  };
  const speech = {
    speechStart() {
      if (closed) return;
      heardSpeech = true;
      options.onSpeechStart();
    },
    speechEnd() {
      if (closed) return;
      // Only a turn with speech in it is committed: the detector's "end" after
      // a muted stretch or a reset would commit silence.
      options.onSpeechEnd(heardSpeech ? commit() : false);
    },
  };

  try {
    if (!track)
      throw new LiveTranscriptionFailure("No microphone is available.", {
        code: "microphone_unavailable",
      });
    pc = new RTCPeerConnection();
    pc.addTrack(track, stream);
    channel = pc.createDataChannel("oai-events");
    channel.addEventListener("open", () => {
      if (!closed) options.onOpen();
    });
    channel.addEventListener("message", (message) => {
      let event: unknown;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (
        event &&
        typeof event === "object" &&
        typeof (event as { type?: unknown }).type === "string"
      ) {
        options.onEvent(event as { type: string });
      }
    });
    channel.addEventListener("close", () => close());
    const peer = pc;
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed") {
        close(
          new LiveTranscriptionFailure("The transcription connection failed.", {
            code: "connection_failed",
          }),
        );
      }
      if (peer.connectionState === "closed") close();
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let answer: string;
    if (connect === "sdp") {
      if (typeof options.source !== "string") {
        throw new TypeError('connect: "sdp" needs the route\'s URL as the source.');
      }
      const response = await post(options.source, { ...options.body, sdp: offer.sdp });
      if (!response.ok) throw await routeError(response, "Live transcription is unavailable");
      answer = String(((await response.json()) as { sdp?: unknown }).sdp ?? "");
    } else {
      const token = await tokenPromise;
      if (!token || typeof token.value !== "string") {
        throw new LiveTranscriptionFailure("The token route answered no secret.", {
          code: "no_token",
        });
      }
      const response = await fetch(token.callsUrl ?? OPENAI_REALTIME_CALLS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
        signal,
      });
      if (!response.ok)
        throw await routeError(response, "The transcription session could not start");
      answer = await response.text();
    }
    if (!answer) throw new LiveTranscriptionFailure("No SDP answer.", { code: "provider_error" });
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    // The level meter, which also feeds the built-in detector.
    const energy =
      options.vad === undefined || options.vad === "energy"
        ? createEnergyVad(options.energy)
        : null;
    if (typeof AudioContext !== "undefined") {
      audioContext = new AudioContext();
      void audioContext.resume?.().catch(() => undefined);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let lastLevel = -1;
      meter = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        // A muted track reads silence, so it ends a turn in progress.
        const rms = track.enabled ? rmsOf(samples) : 0;
        const level = Math.min(1, rms / 0.2);
        if (Math.abs(level - lastLevel) >= 0.02) {
          lastLevel = level;
          options.onLevel(level);
        }
        const change = energy?.push(rms, Date.now());
        if (change === "start") speech.speechStart();
        else if (change === "end") speech.speechEnd();
      }, FRAME_MS);
    } else if (energy) {
      throw new LiveTranscriptionFailure("This browser can't analyse audio.", {
        code: "unsupported",
      });
    }
    if (typeof options.vad === "function") detector = await options.vad(stream, speech);
  } catch (error) {
    close();
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error;
    throw error instanceof LiveTranscriptionFailure
      ? error
      : new LiveTranscriptionFailure("Live transcription could not start.", { cause: error });
  }

  if (closed) {
    throw new LiveTranscriptionFailure("The transcription connection closed while starting.", {
      code: "connection_failed",
    });
  }
  started = true;
  return {
    commit,
    flush: () => (heardSpeech || options.vad === false ? commit() : false),
    send,
    mute(on) {
      if (track) track.enabled = !on;
    },
    close: () => close(),
  };
}
