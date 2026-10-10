import type { ChannelTarget } from "./channels";

// Kept apart from `BroadcastEvent.ts` so `EventManager` can recognise a
// broadcast event without importing a subclass of `Event`, which would close
// the import cycle `Event` -> `EventManager` -> `BroadcastEvent` -> `Event`.

/**
 * Marks a `BroadcastEvent` instance. A symbol in the global registry rather
 * than `instanceof`, for the reason `Event` gives: a production build can hold
 * two copies of an event class, and `instanceof` would tell them apart.
 */
export const BROADCAST_EVENT = Symbol.for("gemi.broadcastEvent");

/** What `EventManager` needs of an event to broadcast it. */
export interface BroadcastableEvent {
  broadcastOn(): ChannelTarget | string | ReadonlyArray<ChannelTarget | string>;
  broadcastAs(): string;
  broadcastWith(): unknown;
}

/** Whether `event` is a `BroadcastEvent`, from any copy of gemi. */
export function isBroadcastEvent(event: unknown): event is BroadcastableEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<symbol, unknown>)[BROADCAST_EVENT] === true
  );
}
