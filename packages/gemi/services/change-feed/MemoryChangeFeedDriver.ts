import type { ChangeFeedDriver, ChangeFeedEntry, ChangeFeedRead } from "./ChangeFeedDriver";

export type MemoryChangeFeedDriverOptions = {
  /** Entries kept per channel. Default `1000`. */
  retain?: number;
};

/**
 * The default driver: each channel's log in this process's memory.
 *
 * **One process only.** Another instance publishes to its own memory, and a
 * subscriber here never hears of it. A restart forgets every channel, and a
 * client resuming with a cursor from before it gets a `reset`, which is the
 * right answer: what it showed must be read again. Use the database driver
 * once there is more than one instance.
 *
 * It has no `listen`: the manager wakes this process's subscribers itself
 * after each publish, and there is nobody else to hear.
 */
export class MemoryChangeFeedDriver implements ChangeFeedDriver {
  private readonly logs = new Map<string, { head: number; entries: ChangeFeedEntry[] }>();
  private readonly retain: number;

  constructor(options: MemoryChangeFeedDriverOptions = {}) {
    const retain = options.retain ?? 1000;
    if (!Number.isInteger(retain) || retain < 1) {
      throw new Error(`The change feed's retain must be a whole number, 1 or more; got ${retain}.`);
    }
    this.retain = retain;
  }

  async publish(channel: string, data: unknown): Promise<number> {
    let log = this.logs.get(channel);
    if (!log) {
      log = { head: 0, entries: [] };
      this.logs.set(channel, log);
    }
    const seq = ++log.head;
    // A structured clone, so a caller mutating its object afterwards does not
    // change what subscribers read, as it could not with the database driver.
    log.entries.push({ seq, data: data === undefined ? null : structuredClone(data) });
    if (log.entries.length > this.retain) log.entries.splice(0, log.entries.length - this.retain);
    return seq;
  }

  async heads(channels: readonly string[]): Promise<Map<string, number>> {
    return new Map(channels.map((channel) => [channel, this.logs.get(channel)?.head ?? 0]));
  }

  async read(channel: string, after: number, limit: number): Promise<ChangeFeedRead> {
    const log = this.logs.get(channel);
    const head = log?.head ?? 0;
    if (after > head) return { entries: [], head, gap: true };
    if (!log || after === head) return { entries: [], head, gap: false };
    const first = log.entries[0]?.seq ?? head + 1;
    if (first > after + 1) return { entries: [], head, gap: true };
    const start = after + 1 - first;
    return { entries: log.entries.slice(start, start + limit), head, gap: false };
  }
}
