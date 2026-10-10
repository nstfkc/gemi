import type { BroadcastRPC } from "../../client/rpc";

/** Any event map: what a channel the app has not typed accepts. */
export type AnyBroadcastEvents = Record<string, unknown>;

/**
 * The events a pattern's channel carries, from the app's generated
 * `BroadcastRPC` (its `ChannelRouter`). A pattern the router does not declare,
 * a concrete topic, or a channel without declared events takes any event.
 */
export type BroadcastEventsFor<P extends string> = P extends keyof BroadcastRPC
  ? BroadcastRPC[P] extends { events: infer E extends Record<string, unknown> }
    ? E
    : AnyBroadcastEvents
  : AnyBroadcastEvents;

/** `emit`'s data argument: optional when the event's payload may be undefined. */
export type BroadcastDataArgs<T> = undefined extends T ? [data?: T] : [data: T];

/** One emit, as the fake records it. */
export interface SentBroadcast {
  /** The concrete topic, e.g. `site.abc123`. */
  topic: string;
  /** The pattern the topic was built from, when it was built from one. */
  pattern?: string;
  /** The event name. */
  event: string;
  /** The payload, as emitted. */
  data: unknown;
  /** The socket `toOthers` skipped, if any. */
  except?: string;
}
