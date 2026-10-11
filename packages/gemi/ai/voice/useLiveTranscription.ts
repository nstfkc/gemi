import { useCallback, useEffect, useRef, useState } from "react";
import type { EnergyVadOptions } from "./energyVad";
import {
  startLiveTranscription,
  type LiveTranscriptionConnection,
  type LiveTranscriptionError,
  type LiveTranscriptionToken,
  type VoiceActivityDetector,
} from "./liveTranscription";
import {
  applyTranscriptionEvent,
  initialTranscriptionState,
  partialText,
  type TranscriptionState,
  type TranscriptTurn,
} from "./transcriptionState";

export type LiveTranscriptionStatus = "idle" | "connecting" | "listening";

export type UseLiveTranscriptionOptions = {
  /** `"token"` (default) or `"sdp"`. See the docs: `"sdp"` lets the route
   *  create the call and meter it on the sideband. */
  connect?: "token" | "sdp";
  /** Sent to the route as JSON with each start. */
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Silence after speech that ends a turn, for the built-in detector.
   *  Default 350 ms. */
  silenceMs?: number;
  /** More options for the built-in detector. */
  energy?: Omit<EnergyVadOptions, "silenceMs">;
  /** `"energy"` (default), your own detector (e.g. `@ricky0123/vad-web`), or
   *  `false` to end turns only with `commit()`. */
  vad?: "energy" | VoiceActivityDetector | false;
  /** The live text changed (a delta arrived, or a turn completed). */
  onPartial?: (text: string) => void;
  /** A turn's final transcript. */
  onFinal?: (turn: TranscriptTurn) => void;
  onSpeechStart?: () => void;
  /** The user stopped; the turn was committed and its final is on the way. */
  onSpeechEnd?: () => void;
  onError?: (error: LiveTranscriptionError) => void;
};

export type UseLiveTranscriptionResult = {
  status: LiveTranscriptionStatus;
  /** What the user is saying now, before the turn is committed. */
  partial: string;
  /** Finished turns, oldest first (the last 50). */
  turns: TranscriptTurn[];
  /** The user is speaking, by the end-of-speech detector. */
  speaking: boolean;
  /** Microphone level, 0–1. */
  level: number;
  muted: boolean;
  /** The last failure. `code` is `microphone_denied`,
   *  `microphone_unavailable`, `unsupported`, `connection_failed`, the
   *  route's error code, or the vendor's. */
  error: LiveTranscriptionError | null;
  /** Asks for the microphone and opens the session. Call it from a user
   *  gesture. Does nothing while a session is starting or live. */
  start(): Promise<void>;
  /** Closes the session and releases the microphone. `{ flush: true }`
   *  commits speech in progress first and waits (up to `timeoutMs`, default
   *  1500) for its final transcript. */
  stop(options?: { flush?: boolean; timeoutMs?: number }): Promise<void>;
  /** Ends the turn now (`input_audio_buffer.commit`), e.g. for push-to-talk or
   *  a "send" button. */
  commit(): void;
  mute(on?: boolean): void;
  /** Clears `turns` and `partial` (not the session). */
  reset(): void;
};

/**
 * Live speech-to-text (#929): the microphone streams to a transcription
 * session (`gpt-live-transcribe` by default) over WebRTC. `partial` grows as
 * the user speaks; when they stop for `silenceMs`, the turn is committed and
 * its final transcript arrives in `turns` and `onFinal`. Nothing is spoken
 * back.
 *
 * `source` is the app's route that answers a client secret (from
 * `realtime.clientSecret({ session: { type: "transcription", … } })`), or a
 * function returning one. With `connect: "sdp"`, it is the route that takes
 * the SDP offer and answers `{ sdp }`.
 *
 * ```tsx
 * const live = useLiveTranscription("/api/voice/token", {
 *   onFinal: (turn) => route(turn.text),
 * });
 * <button onClick={() => (live.status === "idle" ? live.start() : live.stop())}>Voice</button>
 * <p>{live.partial}</p>
 * ```
 *
 * From `gemi/ai/voice`, so only the views that use it load it.
 *
 * @experimental Tested against faked browser APIs only.
 */
export function useLiveTranscription(
  source: string | (() => Promise<LiveTranscriptionToken>),
  options: UseLiveTranscriptionOptions = {},
): UseLiveTranscriptionResult {
  const [status, setStatus] = useState<LiveTranscriptionStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptionState>(initialTranscriptionState);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<LiveTranscriptionError | null>(null);

  const latest = useRef({ source, options });
  latest.current = { source, options };
  const stateRef = useRef(transcript);
  const connectionRef = useRef<LiveTranscriptionConnection | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Resolves `stop({ flush })`'s wait when the last pending final arrives. */
  const drainedRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  const update = useCallback((next: TranscriptionState) => {
    const before = partialText(stateRef.current);
    stateRef.current = next;
    if (!mounted.current) return;
    setTranscript(next);
    const after = partialText(next);
    if (after !== before) latest.current.options.onPartial?.(after);
  }, []);

  const fail = useCallback((failure: LiveTranscriptionError) => {
    if (!mounted.current) return;
    setError(failure);
    latest.current.options.onError?.(failure);
  }, []);

  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.close();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page releases the mic and ends the session (it is billed
      // while open).
      teardown();
    };
  }, [teardown]);

  const start = useCallback(async () => {
    if (connectionRef.current || abortRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setStatus("connecting");
    const { source: src, options: opts } = latest.current;
    let opened = false;
    try {
      const connection = await startLiveTranscription(
        {
          connect: opts.connect,
          source: src,
          body: opts.body,
          headers: opts.headers,
          vad: opts.vad,
          energy: { ...opts.energy, silenceMs: opts.silenceMs },
          onOpen: () => {
            opened = true;
            if (mounted.current && connectionRef.current) setStatus("listening");
          },
          onEvent: (event) => {
            const { state, effects } = applyTranscriptionEvent(stateRef.current, event);
            if (state !== stateRef.current) update(state);
            for (const effect of effects) {
              if (effect.type === "final") {
                if (mounted.current) latest.current.options.onFinal?.(effect.turn);
              } else {
                fail(Object.assign(new Error(effect.message), { code: effect.code }));
              }
            }
            if (stateRef.current.pendingCommits === 0) drainedRef.current?.();
          },
          onSpeechStart: () => {
            if (!mounted.current) return;
            setSpeaking(true);
            latest.current.options.onSpeechStart?.();
          },
          onSpeechEnd: (committed) => {
            if (committed) {
              update({ ...stateRef.current, pendingCommits: stateRef.current.pendingCommits + 1 });
            }
            if (!mounted.current) return;
            setSpeaking(false);
            latest.current.options.onSpeechEnd?.();
          },
          onLevel: (value) => {
            if (mounted.current) setLevel(value);
          },
          onClose: (closeError) => {
            connectionRef.current = null;
            drainedRef.current?.();
            if (!mounted.current) return;
            setStatus("idle");
            setSpeaking(false);
            setLevel(0);
            if (closeError) fail(closeError);
          },
        },
        abort.signal,
      );
      if (abort.signal.aborted) {
        connection.close();
        return;
      }
      connectionRef.current = connection;
      connection.mute(muted);
      if (opened && mounted.current) setStatus("listening");
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (mounted.current) setStatus("idle");
      fail(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [fail, update, muted]);

  const commit = useCallback(() => {
    if (connectionRef.current?.commit()) {
      update({ ...stateRef.current, pendingCommits: stateRef.current.pendingCommits + 1 });
    }
  }, [update]);

  const stop = useCallback(
    async ({ flush = false, timeoutMs = 1500 }: { flush?: boolean; timeoutMs?: number } = {}) => {
      const connection = connectionRef.current;
      if (flush && connection) {
        if (connection.flush()) {
          update({ ...stateRef.current, pendingCommits: stateRef.current.pendingCommits + 1 });
        }
        if (stateRef.current.pendingCommits > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            drainedRef.current = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          drainedRef.current = null;
        }
      }
      teardown();
      if (mounted.current) {
        setStatus("idle");
        setSpeaking(false);
        setLevel(0);
      }
    },
    [teardown, update],
  );

  const mute = useCallback((on?: boolean) => {
    setMuted((was) => {
      const next = on ?? !was;
      connectionRef.current?.mute(next);
      return next;
    });
  }, []);

  const reset = useCallback(
    () =>
      update({ ...initialTranscriptionState(), pendingCommits: stateRef.current.pendingCommits }),
    [update],
  );

  return {
    status,
    partial: partialText(transcript),
    turns: transcript.turns,
    speaking,
    level,
    muted,
    error,
    start,
    stop,
    commit,
    mute,
    reset,
  };
}
