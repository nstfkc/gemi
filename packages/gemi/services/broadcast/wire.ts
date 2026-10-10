/**
 * The frames an emit becomes. Encoded once per emit and handed to every
 * socket on the topic unchanged (`server.publish`), so a frame names its
 * topic and the client maps the topic to its own subscriptions.
 *
 * ```json
 * {"op":"ev","t":"site.abc123","ev":"changed","d":{"pages":["/about"]},"x":"<socket id>"}
 * ```
 *
 * `d` is left out when the emit carried no data. `x` is the socket an emit
 * made with `Broadcast.toOthers(...)` skips: one frame goes to every process
 * and every socket, so the socket it names drops it itself.
 *
 * Open for the transport (PR 2 of #874): `x` shows every subscriber on the
 * topic the sender's socket id, and another client could send that id in
 * its own `X-Gemi-Socket` header to make its own emits skip the victim (a
 * missed hint, recovered at the next resync). Before the protocol is
 * released, either put a keyed hash of the id in `x` (handed to the client in
 * `hello`) or honour `X-Gemi-Socket` only for a socket of the same session.
 */
export interface BroadcastEventFrame {
  op: "ev";
  /** The topic, e.g. `site.abc123`. */
  t: string;
  /** The event name. */
  ev: string;
  /** The payload, when there is one. */
  d?: unknown;
  /** The socket that must ignore this frame. */
  x?: string;
}

/** The request header a client sends its socket id in, for `toOthers`. */
export const SOCKET_ID_HEADER = "x-gemi-socket";

const SOCKET_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether `value` has the shape of a socket id the transport hands out. */
export function isSocketId(value: unknown): value is string {
  return typeof value === "string" && SOCKET_ID.test(value);
}

export function encodeEventFrame(
  topic: string,
  event: string,
  data: unknown,
  except?: string | null,
): string {
  const frame: BroadcastEventFrame = { op: "ev", t: topic, ev: event };
  if (data !== undefined) frame.d = data;
  if (except) frame.x = except;
  return JSON.stringify(frame);
}
