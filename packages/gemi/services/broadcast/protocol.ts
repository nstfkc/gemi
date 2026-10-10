/**
 * The `gemi.v1` WebSocket protocol, shared by the server transport
 * (`SocketHub`) and the browser client (`gemi/client`'s connection manager).
 * Types and constants only: this module is imported by the browser bundle, so
 * it must never import a server module.
 *
 * Every frame is a JSON text frame. Binary frames are refused.
 *
 * From the client:
 *
 * - `{op:"sub", id, ch, p?}`: subscribe `id` (chosen by the client, unique per
 *   socket) to the channel pattern `ch` with params `p`. The server builds
 *   the topic and authorizes it.
 * - `{op:"unsub", id}`
 * - `{op:"ping"}`: answered with `pong`. The client sends one every
 *   `heartbeatMs` and reconnects when it hears nothing for twice that.
 *
 * From the server:
 *
 * - `{op:"hello", socketId, tag, heartbeatMs}`: the first frame. `socketId`
 *   goes in the `X-Gemi-Socket` header of the client's own requests (for
 *   `Broadcast.toOthers`); it is never shown to anyone else. `tag` is what
 *   an event frame's `x` carries when it skips this socket.
 * - `{op:"subscribed", id, t}`: `id` joined topic `t`. Sent only once this
 *   process receives the topic's events, so the resync the client runs on it
 *   cannot miss one.
 * - `{op:"denied", id, code}`: `id` was refused, or later revoked.
 * - `{op:"ev", t, ev, d?, x?}`: an event on topic `t`. Dropped by the socket
 *   whose `tag` is `x`.
 * - `{op:"gap"}`: events may have been lost for this socket; resync all.
 * - `{op:"pong"}`
 * - `{op:"bye", code, retryAfter}`: the server is going away (a restart).
 *   Reconnect after `retryAfter` ms.
 */

/** The WebSocket subprotocol. */
export const BROADCAST_PROTOCOL = "gemi.v1";

/** The default endpoint, `defineBroadcastConfig({ path })`. */
export const DEFAULT_SOCKET_PATH = "/__gemi/socket";

/** The request header a client sends its socket id in, for `toOthers`. */
export const SOCKET_ID_HEADER = "x-gemi-socket";

/** What a subscription id may look like. */
export const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Close codes the server uses. 1012 and 1013 are the standard "restart" and
 * "try again later"; the 4xxx ones are gemi's own.
 */
export const CloseCode = {
  /** The client went away (tab closed, socket released). */
  Normal: 1000,
  /** A frame that was not JSON text, or not a known op. */
  UnsupportedData: 1003,
  /** Too many frames, or a frame over the size limit. */
  PolicyViolation: 1008,
  /** The server is restarting; `bye` said when to come back. */
  Restart: 1012,
  /** The socket fell too far behind; reconnect and resync. */
  TryAgainLater: 1013,
  /** The socket's user was signed out or its access revoked. */
  Revoked: 4001,
} as const;

/** Why a subscription was refused. */
export type DeniedCode =
  /** No channel with that pattern. Permanent. */
  | "unknown_channel"
  /** Missing, extra or malformed params. Permanent. */
  | "invalid_params"
  /** The channel's authorization said no. */
  | "denied"
  /** Authorization failed (a session store outage, a bug). Retryable. */
  | "error"
  /** The socket has `maxChannelsPerSocket` subscriptions already. */
  | "limit"
  /** Too many `sub`/`unsub` frames; retry later. */
  | "rate_limited"
  /** The subscription was revoked by `Broadcast.revoke`. */
  | "revoked"
  /** The frame was malformed, or the id is already in use. */
  | "invalid";

export type ClientFrame =
  | { op: "sub"; id: string; ch: string; p?: Record<string, string | number> }
  | { op: "unsub"; id: string }
  | { op: "ping" };

export type ServerFrame =
  | { op: "hello"; socketId: string; tag: string; heartbeatMs: number }
  | { op: "subscribed"; id: string; t: string }
  | { op: "denied"; id: string; code: DeniedCode }
  | { op: "ev"; t: string; ev: string; d?: unknown; x?: string }
  | { op: "gap" }
  | { op: "pong" }
  | { op: "bye"; code: number; retryAfter: number };

/**
 * Whether a refusal is final for this socket's session: resubscribing will
 * get the same answer, so the client does not retry it on its own.
 */
export function isPermanentDenial(code: DeniedCode): boolean {
  return code === "unknown_channel" || code === "invalid_params" || code === "invalid";
}
