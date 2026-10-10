import { Event } from "../events/Event";
import { BROADCAST_EVENT, type BroadcastableEvent } from "./brand";
import { buildTopic, type ChannelParamsArgs, type ChannelTarget } from "./channels";

export { BROADCAST_EVENT, isBroadcastEvent, type BroadcastableEvent } from "./brand";

/**
 * An event that is also sent to the sockets on a channel, after its listeners
 * have run.
 *
 * ```ts
 * export class SiteChanged extends BroadcastEvent<{ pages: string[] }, "changed"> {
 *   static name = "SiteChanged";
 *   static afterCommit = true;
 *   constructor(public site: { publicId: string }, public changes: { pages: string[] }) {
 *     super();
 *   }
 *   broadcastOn() {
 *     return this.channel("site.:siteId", { siteId: this.site.publicId });
 *   }
 *   broadcastAs() {
 *     return "changed" as const;
 *   }
 *   broadcastWith() {
 *     return this.changes;
 *   }
 * }
 *
 * SiteChanged.dispatch(site, { pages: ["/about"] });
 * ```
 *
 * It is an `Event`: it needs `static name`, listeners bind to it, `static
 * afterCommit` holds both the listeners and the broadcast until the commit,
 * and under `Event.fake()` it is recorded and **not** broadcast. Without
 * `afterCommit`, a dispatch inside a transaction still runs its listeners at
 * once, and the broadcast itself waits for the commit and is dropped on
 * rollback, as every `Broadcast` emit does.
 *
 * `TPayload` is what `broadcastWith` returns and `TName` what `broadcastAs`
 * returns. List the class on a channel with `.events(SiteChanged)` and the
 * generated `BroadcastRPC` types the client's handler for `changed`.
 */
export abstract class BroadcastEvent<TPayload = undefined, TName extends string = string>
  extends Event
  implements BroadcastableEvent
{
  /**
   * Type-only: what `.events(...)` on a channel reads to type `BroadcastRPC`.
   * No field is emitted.
   */
  declare readonly __broadcast: { name: TName; payload: TPayload };

  constructor() {
    super();
    Object.defineProperty(this, BROADCAST_EVENT, { value: true, enumerable: false });
  }

  /**
   * The channel or channels to send this event to: a `this.channel(...)`, a
   * concrete topic such as `` `user.${id}` ``, or an array of them.
   */
  abstract broadcastOn(): ChannelTarget | string | ReadonlyArray<ChannelTarget | string>;

  /** The event name clients see. Defaults to the class's `static name`. */
  broadcastAs(): TName {
    return (this.constructor as { name: string }).name as TName;
  }

  /**
   * The payload clients receive. Nothing by default: a payload is never
   * derived from the event's fields, so nothing is broadcast by accident.
   * Keep it to ids and a change hint, and never put secrets in it.
   */
  broadcastWith(): TPayload {
    return undefined as TPayload;
  }

  /** The channel `pattern` names with `params`, for `broadcastOn`. */
  protected channel<P extends string>(pattern: P, ...params: ChannelParamsArgs<P>): ChannelTarget {
    return { topic: buildTopic(pattern, params[0] ?? {}), pattern };
  }
}
