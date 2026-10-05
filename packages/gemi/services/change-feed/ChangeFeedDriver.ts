/**
 * Where a change feed's log is kept, and how one process hears that another
 * appended to it.
 *
 * ### The model
 *
 * A **channel** is a string naming something that changes: `site:42`,
 * `post:7`, `user:3:inbox`. Every `publish` to a channel appends one entry to
 * its log with the next **seq**: 1, 2, 3, … per channel. A store keeps the
 * last `retain` entries of each channel and forgets older ones.
 *
 * Seqs are commit-ordered within a channel: no reader can see seq 6 while seq
 * 5 may still appear. The database driver gets that by holding the channel's
 * head row for the rest of the publishing transaction.
 *
 * ### The log is the truth; notifications are only wake-ups
 *
 * `listen` tells the manager that a channel *may* have moved. It carries no
 * data, can be duplicated, and can be lost (a dropped connection). Whatever a
 * subscriber delivers, it read from the log with `read`. So a lost
 * notification only delays a change, and a driver that cannot notify across
 * processes at all still works, at the speed of the manager's `pollInterval`.
 */
export interface ChangeFeedDriver {
  /**
   * Appends `data` to `channel`'s log and resolves to its seq. The database
   * driver writes inside the ORM transaction open on its connection, when
   * there is one, so the entry commits with it or not at all.
   */
  publish(channel: string, data: unknown): Promise<number>;

  /**
   * Whether a `publish` made now would be written inside the ORM transaction
   * the caller's async context has open. Optional, `false` when absent. When
   * a transaction is open and the driver does not join it, the manager holds
   * the publish until the commit and drops it on rollback, so nobody is told
   * about a change that is not visible yet, or never will be.
   */
  joinsTransaction?(): boolean;

  /** The latest seq of each channel, `0` for one never published to. */
  heads(channels: readonly string[]): Promise<Map<string, number>>;

  /**
   * Up to `limit` entries of `channel` after `after`, oldest first, with the
   * channel's head. `gap` is `true` when the entries right after `after` are
   * no longer kept, or `after` is ahead of the head (the store was reset):
   * the reader cannot catch up entry by entry and must start again from
   * `head`.
   */
  read(channel: string, after: number, limit: number): Promise<ChangeFeedRead>;

  /**
   * Starts telling `onChange` about entries appended to any channel, by any
   * process sharing the store. `onResync` is called whenever notifications may
   * have been missed (a connection that dropped and came back), and the
   * manager then re-reads every channel it follows. Resolves once listening.
   * May reject when it cannot listen at all; the manager retries.
   *
   * Optional: a driver without it notifies only its own process (the manager
   * wakes its own subscribers after each `publish`), and other processes find
   * entries by polling.
   */
  listen?(
    onChange: (channel: string, seq: number) => void,
    onResync: () => void,
  ): Promise<{ close(): Promise<void> }>;

  /** Releases what the driver holds open. */
  close?(): Promise<void>;
}

/** One kept entry of a channel's log. */
export type ChangeFeedEntry = { seq: number; data: unknown };

export type ChangeFeedRead = {
  entries: ChangeFeedEntry[];
  head: number;
  gap: boolean;
};

/**
 * What a subscriber receives.
 *
 * `change` is one published entry. `reset` means the subscriber could not be
 * brought up to date entry by entry: its cursor was older than what the store
 * keeps, or ahead of the head. Whatever it shows of the channel must be read
 * again; it is now at `seq`.
 */
export type ChangeFeedEvent<T = unknown> =
  | { type: "change"; channel: string; seq: number; data: T }
  | { type: "reset"; channel: string; seq: number };
