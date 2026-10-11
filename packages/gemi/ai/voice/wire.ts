/**
 * What the voice routes and `useVoiceSession` say to each other (#921).
 *
 * Imports nothing, like `ai/types.ts`, so the browser half can read it without
 * a path to the server half.
 */

/** `POST /<route>` — the browser's offer, its thread and the app's `body`. */
export type VoiceStartBody = {
  /** The browser's SDP offer. */
  sdp: string;
  /** The chat thread the voice delegates to, as `useChat` names it. */
  threadId?: string;
  /** Start with voice activity detection off: the client commits each turn. */
  pushToTalk?: boolean;
};

/** What `POST /<route>` answers. */
export type VoiceStartResponse = {
  /** The voice session's id: `PATCH` and `DELETE` `/<route>/<sessionId>`. */
  sessionId: string;
  /** The vendor's SDP answer, for `setRemoteDescription`. */
  sdp: string;
  /** The thread delegated turns are stored on. */
  threadId: string;
  /** The delegate tool's name, so the client can show `working`. */
  delegate: string;
  /** When the server will end the call at the latest, in epoch ms. */
  endsAt?: number;
};

/**
 * What the client shows.
 *
 * - `idle`: not started.
 * - `connecting`: asking for the microphone and setting up the call.
 * - `listening`: the call is up and nobody is speaking, or the user is.
 * - `thinking`: the user stopped speaking and no answer has started.
 * - `speaking`: the voice is talking.
 * - `working`: the agent is working on a delegated request (and the voice is
 *   not speaking).
 * - `ended`: the call is over. `error` is set when it ended on a failure.
 */
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "ended";

/** One line of live captions. */
export type VoiceCaption = {
  /** The vendor's item id. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** `false` while it is still arriving. */
  final: boolean;
};

/** Why a voice session ended. */
export type VoiceEndReason =
  /** `DELETE /<route>/<id>`, `useVoiceSession().end()` or `bridge.end()`. */
  | "hangup"
  /** The vendor ended the call (the browser left, or the vendor's own limit). */
  | "call_ended"
  /** The sideband was lost and could not be re-opened. */
  | "sideband_lost"
  | "max_duration"
  | "idle"
  /** `onUsage` or `onTick` threw a `VoiceHangup`. */
  | "usage"
  /** A `session.updated` showed instructions or tool names other than the
   *  session's: a speed bump against casual edits, not a security boundary. */
  | "session_tampered"
  /** The call could not be started. */
  | "start_failed"
  | "error";
