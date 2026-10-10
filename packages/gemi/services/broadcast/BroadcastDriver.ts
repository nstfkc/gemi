/**
 * Hands a frame to the sockets of this process that joined `topic`. The
 * transport supplies it: on the HTTP server it is `server.publish(topic,
 * frame)`. A driver calls it for every frame it receives, its own included.
 */
export type BroadcastDeliver = (topic: string, frame: string) => void;

/**
 * Decides which processes see an emit. Delivery to sockets is never the
 * driver's job: it always ends in the `deliver` callback of the process that
 * holds them.
 *
 * The contract, which every driver keeps:
 *
 * - **One delivery path.** `publish` never calls `deliver` for frames another
 *   way than it would for another process's frames. The memory driver hands
 *   the frame straight to its own `deliver`; the Redis driver `PUBLISH`es it
 *   and delivers what its subscriber receives back, the sender's own frames
 *   included. So nothing is delivered twice.
 * - **Nothing before `start`.** Until the transport calls `start`, a process
 *   has no sockets, and `publish` may drop the frame for this process (it
 *   still reaches other processes on a shared driver). A process without the
 *   HTTP server, a `gemi queue:work` worker say, never calls `start`.
 * - **Frames are opaque.** The driver never parses or logs them.
 * - **At most once.** No acknowledgement, no retry, no replay. A driver that
 *   may have lost frames (a Redis subscriber that reconnected) says so with
 *   `onGap`, and the transport tells its sockets to resync.
 */
export interface BroadcastDriver {
  /** Fans `frame` out to every process that has sockets on `topic`. */
  publish(topic: string, frame: string): void | Promise<void>;

  /**
   * This process starts receiving: from now on, every frame published on a
   * topic this process has sockets on reaches `deliver`. Called once, by the
   * transport, when the HTTP server starts.
   */
  start(deliver: BroadcastDeliver, hooks?: BroadcastDriverHooks): void | Promise<void>;

  /** The first local socket joined `topic`. Lets a driver subscribe per topic. */
  topicAdded?(topic: string): void | Promise<void>;

  /** The last local socket left `topic`. */
  topicRemoved?(topic: string): void | Promise<void>;

  /** Stops receiving and releases connections. Called on shutdown. */
  close(): void | Promise<void>;
}

export interface BroadcastDriverHooks {
  /**
   * Frames may have been lost for this process, for instance while a Redis
   * subscriber reconnected. The transport sends its sockets a `gap` frame and
   * clients refetch.
   */
  onGap?(): void;
}
