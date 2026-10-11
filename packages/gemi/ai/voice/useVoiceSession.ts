import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RPC } from "../../client/rpc";
import { applyVoiceEvent, initialVoiceState, voiceStatus, type VoiceState } from "./state";
import { startVoiceCall, type VoiceCall } from "./voiceCall";
import type { VoiceCaption, VoiceStatus } from "./wire";

/**
 * The voice routes, picked out of `RPC` the way `useChat` picks its agent
 * routes: `this.voice(Controller)` mounted at `"/chat/voice"` is the key
 * `"/chat/voice"`, carrying the controller's `Body`.
 */
type VoiceRoutes = {
  [K in keyof RPC as RPC[K] extends { __voice: true } ? K : never]: RPC[K];
};

type BodyOf<P extends keyof VoiceRoutes> = VoiceRoutes[P] extends { body: infer B }
  ? B
  : Record<string, unknown>;

export type UseVoiceSessionParams<P extends keyof VoiceRoutes> = {
  /** The chat thread delegated turns are stored on, as `useChat` names it. */
  threadId?: string;
  /** The controller's `Body`, sent when the call starts. Change it during the
   *  call with `setBody`. */
  body?: BodyOf<P>;
  /** Start with push-to-talk instead of voice activity detection. */
  pushToTalk?: boolean;
  /** Values for the route path's `:params`, e.g. `{ siteId }` for
   *  `"/sites/:siteId/voice"`. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
  /** The call could not start, or failed. */
  onError?: (error: Error) => void;
  /** The call is over, however it ended. */
  onEnd?: () => void;
};

export type UseVoiceSessionResult<P extends keyof VoiceRoutes> = {
  status: VoiceStatus;
  /** The last lines said, the user's and the voice's, oldest first. */
  captions: VoiceCaption[];
  /** Why the call could not start or ended early. `code` is
   *  `microphone_denied`, `unsupported`, or the route's error code. */
  error: (Error & { code?: string; status?: number }) | null;
  muted: boolean;
  pushToTalk: boolean;
  /** When the server will end the call, in epoch ms. */
  endsAt?: number;
  sessionId?: string;
  /** Asks for the microphone and starts the call. Call it from a user gesture
   *  (a click): browsers allow the microphone and audio playback only then. */
  start(): Promise<void>;
  /** Hangs up. */
  end(): Promise<void>;
  mute(muted?: boolean): void;
  setPushToTalk(on: boolean): void;
  /** Push-to-talk: hold to speak (pointer down / key down). */
  press(): void;
  /** Push-to-talk: release to send (pointer up / key up). */
  release(): void;
  /** Sends a new `body` (the selection, the open page) for the next
   *  delegated request. */
  setBody(body: BodyOf<P>): Promise<void>;
};

/**
 * A voice call to an agent, for a route mounted with `this.voice(Controller)`
 * (#921).
 *
 * ```tsx
 * const voice = useVoiceSession("/page-builder/voice", { threadId, body: { pageId } });
 * <button onClick={() => (voice.status === "idle" ? voice.start() : voice.end())}>
 *   {voice.status}
 * </button>
 * ```
 *
 * Import it from `gemi/ai/voice`, an entry of its own, so an app that never
 * uses voice never bundles it, and use it from a view or a dynamically imported
 * component, so its code is not in the entry chunk.
 */
export function useVoiceSession<P extends keyof VoiceRoutes>(
  path: P,
  params: UseVoiceSessionParams<P> = {},
): UseVoiceSessionResult<P> {
  // Not `useParams()`, which `useChat` uses: it is in a chunk `gemi/client`
  // shares, and reaching it from here made the app's bundler move it out of
  // the entry chunk into one of its own that every route then imports. A path
  // with parameters names them in `params`.
  const routeParams = params.params;
  const url = useMemo(() => {
    let out = String(path).replace(/^[A-Z]+:/, "");
    for (const [key, value] of Object.entries(routeParams ?? {})) {
      out = out.replace(`:${key}?`, value).replace(`:${key}`, value);
    }
    return `/api${out}`;
  }, [path, routeParams && JSON.stringify(routeParams)]);

  const [state, setState] = useState<VoiceState>(initialVoiceState);
  const [error, setError] = useState<UseVoiceSessionResult<P>["error"]>(null);
  const [muted, setMuted] = useState(false);
  const [pushToTalk, setPushToTalkState] = useState(params.pushToTalk === true);
  const [call, setCall] = useState<VoiceCall | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const latest = useRef(params);
  latest.current = params;
  const delegateRef = useRef("ask_agent");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page ends the call: minutes are billed while it is up.
      void callRef.current?.end().catch(() => undefined);
      callRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (callRef.current) return;
    setError(null);
    setState({ ...initialVoiceState(), phase: "connecting" });
    try {
      const { threadId, body, headers } = latest.current;
      const started = await startVoiceCall({
        url,
        threadId,
        body,
        headers,
        pushToTalk,
        onEvent: (event) => {
          if (!mounted.current) return;
          setState((current) =>
            current.phase === "connecting"
              ? applyVoiceEvent({ ...current, phase: "live" }, event, delegateRef.current)
              : applyVoiceEvent(current, event, delegateRef.current),
          );
        },
        onClose: (closeError) => {
          callRef.current = null;
          if (!mounted.current) return;
          setCall(null);
          setState((current) => ({ ...current, phase: "ended", speaking: false, thinking: false }));
          if (closeError) {
            setError(closeError);
            latest.current.onError?.(closeError);
          }
          latest.current.onEnd?.();
        },
      });
      delegateRef.current = started.delegate;
      if (!mounted.current) {
        await started.end().catch(() => undefined);
        return;
      }
      callRef.current = started;
      setCall(started);
      setState((current) =>
        current.phase === "connecting" ? { ...current, phase: "live" } : current,
      );
    } catch (failure) {
      const reported = failure instanceof Error ? failure : new Error(String(failure));
      if (!mounted.current) return;
      setState((current) => ({ ...current, phase: "ended" }));
      setError(reported);
      latest.current.onError?.(reported);
    }
  }, [url, pushToTalk]);

  const end = useCallback(async () => {
    const current = callRef.current;
    callRef.current = null;
    await current?.end();
  }, []);

  const mute = useCallback((on?: boolean) => {
    setMuted((was) => {
      const next = on ?? !was;
      callRef.current?.mute(next);
      return next;
    });
  }, []);

  const setPushToTalk = useCallback((on: boolean) => {
    setPushToTalkState(on);
    callRef.current?.setPushToTalk(on);
  }, []);

  const press = useCallback(() => {
    callRef.current?.press();
    setState((current) => ({ ...current, userSpeaking: true }));
  }, []);

  const release = useCallback(() => {
    callRef.current?.release();
    setState((current) => ({ ...current, userSpeaking: false, thinking: true }));
  }, []);

  const setBody = useCallback(async (body: BodyOf<P>) => {
    latest.current = { ...latest.current, body };
    await callRef.current?.setBody(body);
  }, []);

  return {
    status: voiceStatus(state),
    captions: state.captions,
    error,
    muted,
    pushToTalk,
    endsAt: call?.endsAt,
    sessionId: call?.sessionId,
    start,
    end,
    mute,
    setPushToTalk,
    press,
    release,
    setBody,
  };
}
