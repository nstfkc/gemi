import type { BroadcastEventsFor } from "../services/broadcast/types";
import {
  BroadcastManager,
  type BroadcastScope,
  type PendingBroadcast,
  type SocketSource,
} from "../services/broadcast/BroadcastManager";
import type { ChannelParamsArgs, ChannelTarget } from "../services/broadcast/channels";
import { FakeBroadcastManager } from "../services/broadcast/FakeBroadcastManager";
import { app } from "../foundation/app";
import { Facade } from "./Facade";

/**
 * Real-time push to the WebSocket clients subscribed to a channel. Volatile:
 * events are change hints, delivered at most once and never replayed, and a
 * client that may have missed one refetches over HTTP. For a durable,
 * resumable log use `ChangeFeed`.
 *
 * ```ts
 * Broadcast.to("site.:siteId", { siteId: site.publicId }).emit("changed", { pages: ["/about"] });
 * Broadcast.toUser(user).emit("credits", { balance });
 * Broadcast.toOthers(req).to("page.:pageId", { pageId }).emit("changed");
 * ```
 *
 * Inside an ORM transaction an emit waits for the commit and is dropped on
 * rollback. A channel or payload that is refused throws at the call site.
 */
export class Broadcast extends Facade {
  static getFacadeAccessor() {
    return BroadcastManager;
  }

  /**
   * The channel `pattern` names with `params` (`"site.:siteId"`, `{ siteId }`),
   * a concrete topic, or a `ChannelTarget`.
   */
  static to<P extends string>(
    pattern: P | ChannelTarget,
    ...params: ChannelParamsArgs<P>
  ): PendingBroadcast<BroadcastEventsFor<P>> {
    return this.getFacadeRoot().to(pattern, ...params);
  }

  /** A user's own channel, `user.<id>`, which the router's `"user"` channel joins. */
  static toUser(
    user: { id: unknown } | string | number,
  ): PendingBroadcast<BroadcastEventsFor<"user">> {
    return this.getFacadeRoot().toUser(user);
  }

  /**
   * Skips the sender's socket: pass the request (its `X-Gemi-Socket` header)
   * or the socket id.
   */
  static toOthers(source: SocketSource): BroadcastScope {
    return this.getFacadeRoot().toOthers(source);
  }

  /**
   * Closes subscriptions that may no longer be allowed: every socket of a
   * user (`{ user }`), or every subscription to a channel (`{ channel,
   * params? }`). Clients reconnect or resubscribe, and authorization runs
   * again. Sign-out calls it for the user.
   *
   * ```ts
   * Broadcast.revoke({ channel: "site.:siteId", params: { siteId } }); // after removing a member
   * ```
   */
  static revoke(
    target:
      | { user: { id: unknown } | string | number }
      | { channel: string | ChannelTarget; params?: Record<string, unknown> },
  ): void {
    this.getFacadeRoot().revoke(target);
  }

  /**
   * Swaps the container's `BroadcastManager` for a recorder and returns it.
   * Call `restore()` when the test is done.
   *
   * ```ts
   * const broadcasts = Broadcast.fake();
   * await post("/pages/abc/save", body);
   * broadcasts.assertSent("page.:pageId", "changed", (d) => d.pages.includes("/about"));
   * broadcasts.restore();
   * ```
   */
  static fake(): FakeBroadcastManager {
    return FakeBroadcastManager.install(app());
  }
}
