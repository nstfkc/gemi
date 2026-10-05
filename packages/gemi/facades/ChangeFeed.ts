import type { ChangeFeedEvent } from "../services/change-feed/ChangeFeedDriver";
import {
  ChangeFeedManager,
  type ChangeFeedSubscription,
  type SubscribeOptions,
} from "../services/change-feed/ChangeFeedManager";
import type { ChangeFeedResponse, StreamOptions } from "../services/change-feed/stream";
import { Facade } from "./Facade";

/**
 * Change feeds: tell whoever is looking at something that it changed, in
 * this process or on any instance sharing the driver's store.
 *
 * ```ts
 * // Where something changes, inside its transaction or not:
 * await ChangeFeed.publish(`site:${site.id}`, { pages: ["/about"] });
 *
 * // A route that streams it, after authorising the read like any other:
 * "/sites/:siteId/changes": this.get(async (req: HttpRequest) => {
 *   const site = await Site.findUniqueOrThrow({ where: { publicId: req.params.siteId } });
 *   return ChangeFeed.stream<SiteChange>(req, `site:${site.id}`);
 * }),
 * ```
 *
 * The browser follows the route with `useSubscription` from `gemi/client`.
 */
export class ChangeFeed extends Facade {
  static getFacadeAccessor() {
    return ChangeFeedManager;
  }

  /**
   * Appends `data` to `channel` and wakes its subscribers. Inside an ORM
   * transaction, nobody is woken before the commit and nothing is published
   * on rollback. Resolves to the new seq, or `null` when the publish waits
   * for the commit.
   */
  static publish(channel: string, data?: unknown): Promise<number | null> {
    return this.getFacadeRoot().publish(channel, data);
  }

  /** The latest seq of `channel`, `0` before its first publish. */
  static head(channel: string): Promise<number> {
    return this.getFacadeRoot().head(channel);
  }

  /** A cursor at the channels' heads, for a view to hand its client. */
  static cursor(channels: string | readonly string[]): Promise<string> {
    return this.getFacadeRoot().cursor(channels);
  }

  /** Follows `channels` from `options.cursor`, as an async iterator. */
  static subscribe(
    channels: string | readonly string[],
    options?: SubscribeOptions,
  ): ChangeFeedSubscription & AsyncIterable<ChangeFeedEvent> {
    return this.getFacadeRoot().subscribe(channels, options);
  }

  /** An SSE response following `channels`, resuming from `Last-Event-ID`. */
  static stream<T = unknown>(
    request: { rawRequest: Request } | Request,
    channels: string | readonly string[],
    options?: StreamOptions,
  ): ChangeFeedResponse<T> {
    return this.getFacadeRoot().stream<T>(request, channels, options);
  }
}
