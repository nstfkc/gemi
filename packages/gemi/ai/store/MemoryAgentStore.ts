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
 */
export class MemoryAgentStore implements AgentStore {
  readonly ttlMs: number;

  private threads = new Map<string, Thread>();
  private lastSweep = 0;

  constructor(params: { ttlMs?: number } = {}) {
    this.ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
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

  async loadThread(threadId: string): Promise<AgentMessage[]> {
    this.sweep();
    const thread = this.threads.get(threadId);
    if (!thread) {
      // An unknown thread reads as empty rather than throwing: a thread that
      // expired, and one the client invented, are the same situation to a
      // conversation that has to keep working.
      return [];
    }
    thread.touchedAt = Date.now();
    // Copied, so a caller that sorts or splices the result does not edit the
    // stored history in place.
    return thread.messages.slice();
  }

  async appendMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    this.sweep();
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.messages.push(...messages);
      thread.touchedAt = Date.now();
      return;
    }
    // Appending to a thread the store has never seen creates it. The client
    // owns the id in stateless-with-a-thread-id setups, so refusing here would
    // mean losing a turn that already happened.
    this.threads.set(threadId, { messages: messages.slice(), touchedAt: Date.now() });
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
