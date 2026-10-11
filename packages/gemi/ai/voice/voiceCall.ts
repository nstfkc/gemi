import type { VoiceStartResponse } from "./wire";

/**
 * The browser's half of a voice call (#921): the microphone, the peer
 * connection, the vendor's data channel and the app's three routes.
 *
 * Only `gemi/ai/voice` reaches it, so it is in an app's bundle only where the
 * app uses that entry. The packaging test checks it stays out of the entry
 * chunk.
 *
 * No vendor SDK: a raw `RTCPeerConnection`, with the audio going straight to
 * the vendor and the SDP offer going to the app's route, which creates the
 * call with the server's key. The browser never holds a key or a secret.
 */

export type VoiceCallOptions = {
  /** `/api/<route>`. */
  url: string;
  threadId?: string;
  body?: unknown;
  pushToTalk?: boolean;
  headers?: Record<string, string>;
  /** Every vendor event from the data channel. */
  onEvent: (event: { type: string; [key: string]: unknown }) => void;
  /** The connection closed or failed. */
  onClose: (error?: Error) => void;
  /** What push-to-talk turns detection back on to. Default semantic VAD. */
  turnDetection?: Record<string, unknown>;
};

export type VoiceCall = {
  sessionId: string;
  threadId: string;
  delegate: string;
  endsAt?: number;
  mute(muted: boolean): void;
  setPushToTalk(on: boolean): void;
  /** Push-to-talk: start speaking. */
  press(): void;
  /** Push-to-talk: done speaking; the turn is committed and answered. */
  release(): void;
  setBody(body: unknown): Promise<void>;
  /** Hangs up through the app's route and closes everything. */
  end(): Promise<void>;
  /** Closes everything without telling the server (it learns from the vendor). */
  close(): void;
};

export class VoiceCallError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "VoiceCallError";
    this.status = options.status;
    this.code = options.code;
  }
}

export async function startVoiceCall(options: VoiceCallOptions): Promise<VoiceCall> {
  if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new VoiceCallError("This browser can't make voice calls.", { code: "unsupported" });
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new VoiceCallError("The microphone is not available.", {
      code: "microphone_denied",
      cause: error,
    });
  }
  const track = stream.getAudioTracks()[0]!;
  let pushToTalk = options.pushToTalk === true;
  let muted = false;
  track.enabled = !pushToTalk;

  const pc = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
  };
  pc.addTrack(track, stream);
  const channel = pc.createDataChannel("oai-events");

  let closed = false;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    try {
      channel.close();
    } catch {
      // already closed
    }
    pc.close();
    for (const t of stream.getTracks()) t.stop();
    audio.srcObject = null;
    options.onClose(error);
  };

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
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") close(new VoiceCallError("The voice connection failed."));
    if (pc.connectionState === "closed") close();
  });

  // Events sent before the data channel opens (push-to-talk pressed at once)
  // wait for it rather than being dropped.
  const outbox: string[] = [];
  channel.addEventListener("open", () => {
    for (const data of outbox.splice(0)) channel.send(data);
  });
  const send = (event: Record<string, unknown>) => {
    const data = JSON.stringify(event);
    if (channel.readyState === "open") channel.send(data);
    else if (channel.readyState === "connecting") outbox.push(data);
  };
  const request = (method: string, url: string, payload?: unknown, init: RequestInit = {}) =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...options.headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      ...init,
    });

  let started: VoiceStartResponse;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await request("POST", options.url, {
      ...(options.body && typeof options.body === "object" ? options.body : {}),
      sdp: offer.sdp,
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(pushToTalk ? { pushToTalk: true } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new VoiceCallError(
        error?.error?.message ?? `The voice call could not be started (${response.status}).`,
        { status: response.status, code: error?.error?.code },
      );
    }
    started = await response.json();
    await pc.setRemoteDescription({ type: "answer", sdp: started.sdp });
  } catch (error) {
    close();
    throw error instanceof VoiceCallError
      ? error
      : new VoiceCallError("The voice call could not be started.", { cause: error });
  }

  const sessionUrl = `${options.url}/${encodeURIComponent(started.sessionId)}`;
  const applyTrack = () => {
    track.enabled = !muted && !pushToTalk;
  };

  return {
    sessionId: started.sessionId,
    threadId: started.threadId,
    delegate: started.delegate,
    endsAt: started.endsAt,
    mute(on) {
      muted = on;
      applyTrack();
    },
    setPushToTalk(on) {
      pushToTalk = on;
      applyTrack();
      send({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              turn_detection: on ? null : (options.turnDetection ?? { type: "semantic_vad" }),
            },
          },
        },
      });
    },
    press() {
      if (!pushToTalk || muted) return;
      send({ type: "input_audio_buffer.clear" });
      track.enabled = true;
    },
    release() {
      if (!pushToTalk) return;
      track.enabled = false;
      send({ type: "input_audio_buffer.commit" });
      send({ type: "response.create" });
    },
    async setBody(body) {
      const response = await request("PATCH", sessionUrl, body ?? {});
      if (!response.ok && response.status !== 409) {
        throw new VoiceCallError(`The voice session could not be updated (${response.status}).`, {
          status: response.status,
        });
      }
    },
    async end() {
      try {
        // `keepalive`, so a hang-up sent as the tab closes still reaches the
        // route: minutes are billed until it does.
        await request("DELETE", sessionUrl, undefined, { keepalive: true });
      } finally {
        close();
      }
    },
    close: () => close(),
  };
}
