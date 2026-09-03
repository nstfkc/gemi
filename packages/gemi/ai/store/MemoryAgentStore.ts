import type { AgentStore } from "../AgentController";
import type { AgentMessage } from "../types";

/** A day. Long enough that a conversation survives a lunch break, short enough
 *  that a chat nobody came back to is not still resident a week later. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the map is walked looking for expired threads. */
const SWEEP_INTERVAL_MS = 60 * 1000;

type Thread = {
  messages: AgentMessage[];
  /** Bumped by every read and every write: a conversation someone is still
   *  having must not expire out from under them mid-turn. */
  touchedAt: number;
};

/**
 * The default store: conversations last as long as the process.
 *
 * It exists so that `threadId` works out of the box, not so that anything is
 * durable — a restart loses every thread, and a second server never had them.
 * That is the honest default for a framework store, and it is why stateless is
 * still the mode an app gets without asking: the client carrying its own
 * history survives a deploy, and this does not.
 *
 * Expiry is swept lazily rather than on a timer. A `setTimeout` per thread is a
 * timer per conversation and a reference the GC cannot collect, and an interval
 * running forever keeps a process alive that has nothing else to do — so the
 * sweep happens on access, at most once a minute, and an untouched process
 * simply stops sweeping.
 *
 * A thread the store does not have is `null` from `loadThread` and an error
 * from `appendMessages`, never an empty conversation. It used to be the other
 * way, and the three ways a thread goes missing — it expired, the id was
 * mistyped, it lived on an instance that was scaled in — all read as a fresh
 * chat: the history was gone with no signal, and the next turn was persisted
 * under the dead id as though it were the first. `clientOwnedIds` is the one
 * setup where an unknown id is not a lost thread, because the client minted it.
 */
export class MemoryAgentStore implements AgentStore {
  readonly ttlMs: number;
  /** The ids come from the client, not from `createThread`, so an id this
   *  store has never seen is a conversation starting rather than one lost. */
  readonly clientOwnedIds: boolean;

  private threads = new Map<string, Thread>();
  private lastSweep = 0;

  constructor(params: { ttlMs?: number; clientOwnedIds?: boolean } = {}) {
    this.ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
    this.clientOwnedIds = params.clientOwnedIds ?? false;
  }

  async createThread(params: { userId?: string | number }): Promise<{ threadId: string }> {
    // The user id is not part of the id and not stored: this store cannot
    // authorize anything, and an id that looked like a key would invite an app
    // to treat it as one. Ownership belongs to the app's own table.
    void params;
    const threadId = crypto.randomUUID();
    this.threads.set(threadId, { messages: [], touchedAt: Date.now() });
    this.sweep();
    return { threadId };
  }

  async loadThread(threadId: string): Promise<AgentMessage[] | null> {
    this.sweep();
    const thread = this.threads.get(threadId);
    if (!thread) {
      // With client-owned ids the first turn arrives before anything has been
      // written under it, so unknown is empty. Otherwise unknown is a thread
      // that expired or never existed, and the controller has to be able to
      // tell: `[]` here is the silent fresh conversation this store used to
      // hand out in place of the user's history.
      return this.clientOwnedIds ? [] : null;
    }
    thread.touchedAt = Date.now();
    // Copied, so a caller that sorts or splices the result does not edit the
    // stored history in place.
    return thread.messages.slice();
  }

  async appendMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    this.sweep();
    let thread = this.threads.get(threadId);
    if (!thread) {
      if (!this.clientOwnedIds) {
        // Creating the thread here would persist a turn under an id the client
        // believes holds a longer conversation, and hide from the app that the
        // conversation is gone. The controller checks before the run and never
        // reaches this; a store-level caller that does gets told.
        throw new Error(`Thread ${threadId} does not exist here, or has expired.`);
      }
      // The client owns the id, so an append to one the store has never seen is
      // the first turn, and refusing it would lose a turn that already happened.
      thread = { messages: [], touchedAt: Date.now() };
      this.threads.set(threadId, thread);
    }
    // Upsert, not push. A turn that resolves a pending call hands back the
    // assistant message that made the call under the id it already had, now
    // with the result attached; pushing it would leave the thread holding both
    // versions, and the model would read the same call twice on every turn
    // that follows. Replacing in place keeps the message where the
    // conversation put it.
    for (const message of messages) {
      const at = thread.messages.findIndex((held) => held.id === message.id);
      if (at === -1) {
        thread.messages.push(message);
      } else {
        thread.messages[at] = message;
      }
    }
    thread.touchedAt = Date.now();
  }

  /** Test seam, and a way for an app to drop a conversation on request. */
  delete(threadId: string): void {
    this.threads.delete(threadId);
  }

  get size(): number {
    return this.threads.size;
  }

  sweep(now = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [threadId, thread] of this.threads) {
      if (now - thread.touchedAt > this.ttlMs) {
        this.threads.delete(threadId);
      }
    }
  }
}

/**
 * The process-wide default every `AgentController` uses unless it is given
 * another.
 *
 * It has to be a shared instance, not a field initializer. A gemi controller is
 * constructed per request — `RouteHandler.run()` does `new Controller()` every
 * time — so `store = new MemoryAgentStore()` written in a controller field is a
 * brand new, empty store on every turn, and a threaded conversation would read
 * back nothing while looking like it was configured correctly. Anything
 * process-lived that a controller holds has to be created outside it.
 */
export const defaultAgentStore = new MemoryAgentStore();
