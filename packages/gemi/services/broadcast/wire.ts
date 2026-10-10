/**
 * The frames an emit becomes. Encoded once per emit and handed to every
 * socket on the topic unchanged (`server.publish`), so a frame names its
 * topic and the client maps the topic to its own subscriptions.
 *
 * ```json
 * {"op":"ev","t":"site.abc123","ev":"changed","d":{"pages":["/about"]},"x":"<socket id>"}
 * ```
 *
 * `d` is left out when the emit carried no data. `x` is set by an emit made
 * with `Broadcast.toOthers(...)`: one frame goes to every process and every
 * socket, so the socket it names drops it itself.
 *
 * `x` is the skipped socket's *tag*, a keyed hash of its id (`socketTag`),
 * never the id itself. Every subscriber on the topic sees `x`; had it been
 * the id, any of them could have sent it in its own `X-Gemi-Socket` header
 * and made the server skip the victim for that client's emits. The id is
 * only ever in the `hello` the socket's own client receives.
 */
export interface BroadcastEventFrame {
  op: "ev";
  /** The topic, e.g. `site.abc123`. */
  t: string;
  /** The event name. */
  ev: string;
  /** The payload, when there is one. */
  d?: unknown;
  /** The tag of the socket that must ignore this frame. */
  x?: string;
}

export { SOCKET_ID_HEADER } from "./protocol";

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
