import type { AgentStore, CreateThreadParams, ThreadSweepResult } from "../AgentController";
import { keepSummary, type ThreadSummary } from "../contextCompaction";
import type { AgentMessage } from "../types";

/** A day. Long enough that a conversation survives a lunch break, short enough
 *  that a chat nobody came back to is not still resident a week later. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the map is walked looking for expired threads. */
const SWEEP_INTERVAL_MS = 60 * 1000;

type Thread = {
  messages: AgentMessage[];
  /** The `forScope` view that created it (#1177); absent for the store itself. */
  scope?: string;
  /** `contextWindow.compact`'s summaries of this thread, most recent first. */
  summaries?: ThreadSummary[];
  /** Epoch milliseconds it expires at, or `null` for a thread that does not. */
  expiresAt: number | null;
  /** How far each read and write moves `expiresAt` (a sliding thread), or
   *  `null` for a fixed expiry. A conversation someone is still having must
   *  not expire out from under them mid-turn. */
  slideMs: number | null;
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
  /** How long a thread lasts: after its last read or write, or after it was created when `slidingTtl` is `false`. */
  readonly ttlMs: number;
  /** Each read and write restarts a thread's `ttlMs` (the default), or not (`false`). */
  readonly slidingTtl: boolean;
  /** The ids come from the client, not from `createThread`, so an id this
   *  store has never seen is a conversation starting rather than one lost. */
  readonly clientOwnedIds: boolean;

  /** The scope this view is bound to (`forScope`), or `null` for the store itself. */
  readonly scope: string | null = null;

  private threads = new Map<string, Thread>();
  private lastSweep = 0;

  constructor(params: { ttlMs?: number; slidingTtl?: boolean; clientOwnedIds?: boolean } = {}) {
    this.ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
    this.slidingTtl = params.slidingTtl ?? true;
    this.clientOwnedIds = params.clientOwnedIds ?? false;
  }

  /**
   * This store bound to one scope (#1177), over the same threads: a thread
   * created or first written through the view is in its scope, and the view
   * sees no thread of another. The store itself sees every thread.
   */
  forScope(scope: string): MemoryAgentStore {
    if (typeof scope !== "string" || scope === "") {
      throw new TypeError("A MemoryAgentStore scope is a non-empty string.");
    }
    const view = new MemoryAgentStore({
      ttlMs: this.ttlMs,
      slidingTtl: this.slidingTtl,
      clientOwnedIds: this.clientOwnedIds,
    });
    view.threads = this.threads;
    (view as { scope: string | null }).scope = scope;
    return view;
  }

  /**
   * The thread, if this store or view may see it. One that has expired is
   * dropped here (#1312), not only by the next sweep, so it is never read or
   * written after its time.
   */
  private visible(threadId: string, now = Date.now()): Thread | undefined {
    const thread = this.threads.get(threadId);
    if (thread && isExpired(thread, now)) {
      this.threads.delete(threadId);
      return undefined;
    }
    if (!thread || this.scope === null || thread.scope === this.scope) return thread;
    return undefined;
  }

  /** A fresh thread, in this view's scope, with `params`' expiry or the store's. */
  private fresh(params: CreateThreadParams = {}): Thread {
    const now = Date.now();
    let expiresAt: number | null;
    let slideMs: number | null = null;
    if (params.expiresAt !== undefined) {
      expiresAt = params.expiresAt instanceof Date ? params.expiresAt.getTime() : params.expiresAt;
      if (!Number.isFinite(expiresAt)) throw new TypeError("createThread: `expiresAt` is not a valid time.");
    } else {
      const ttlMs = params.ttlMs === undefined ? this.ttlMs : params.ttlMs;
      if (ttlMs !== null && !(typeof ttlMs === "number" && ttlMs > 0)) {
        throw new TypeError("createThread: ttlMs must be a positive number of milliseconds.");
      }
      expiresAt = ttlMs === null ? null : now + ttlMs;
      slideMs = this.slidingTtl ? ttlMs : null;
    }
    return {
      messages: [],
      expiresAt,
      slideMs,
      ...(this.scope !== null ? { scope: this.scope } : {}),
    };
  }

  /** A read or write: a sliding thread's expiry starts again. */
  private touch(thread: Thread) {
    if (thread.slideMs !== null) thread.expiresAt = Date.now() + thread.slideMs;
  }

  /**
   * `ttlMs` (or `null`, never) and `expiresAt` set this thread's expiry in
   * place of the store's `ttlMs`, as `DatabaseAgentStore` takes them.
   */
  async createThread(params: CreateThreadParams = {}): Promise<{ threadId: string }> {
    // The user id is not part of the id and not stored: this store cannot
    // authorize anything, and an id that looked like a key would invite an app
    // to treat it as one. Ownership belongs to the app's own table.
    const threadId = crypto.randomUUID();
    this.threads.set(threadId, this.fresh(params));
    this.sweep();
    return { threadId };
  }

  async loadThread(threadId: string): Promise<AgentMessage[] | null> {
    this.sweep();
    const thread = this.visible(threadId);
    if (!thread) {
      // Another scope's thread is not this view's to start.
      if (this.threads.has(threadId)) return null;
      // With client-owned ids the first turn arrives before anything has been
      // written under it, so unknown is empty. Otherwise unknown is a thread
      // that expired or never existed, and the controller has to be able to
      // tell: `[]` here is the silent fresh conversation this store used to
      // hand out in place of the user's history.
      return this.clientOwnedIds ? [] : null;
    }
    this.touch(thread);
    // Copied, so a caller that sorts or splices the result does not edit the
    // stored history in place.
    return thread.messages.slice();
  }

  async appendMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    this.sweep();
    let thread = this.visible(threadId);
    if (!thread) {
      if (!this.clientOwnedIds || this.threads.has(threadId)) {
        // Creating the thread here would persist a turn under an id the client
        // believes holds a longer conversation, and hide from the app that the
        // conversation is gone. The controller checks before the run and never
        // reaches this; a store-level caller that does gets told.
        throw new Error(`Thread ${threadId} does not exist here, or has expired.`);
      }
      // The client owns the id, so an append to one the store has never seen is
      // the first turn, and refusing it would lose a turn that already happened.
      thread = this.fresh();
      this.threads.set(threadId, thread);
    }
    // Upsert, not push. A turn that resolves a pending call hands back the
    // assistant message that made the call under the id it already had, now
    // with the result attached; pushing it would leave the thread holding both
    // versions, and the model would read the same call twice on every turn
    // that follows. Replacing in place keeps the message where the
    // conversation put it.
    for (const written of messages) {
      // Stored as JSON, like every other store (#1107): what `loadThread` and
      // `readThread` hand back is what a database store would, and what the
      // client types say it is (`Date`s are strings, `undefined` members gone).
      // It is also a copy, so the caller mutating its message later does not
      // edit the stored history.
      const message = JSON.parse(JSON.stringify(written)) as AgentMessage;
      const at = thread.messages.findIndex((held) => held.id === message.id);
      if (at === -1) {
        thread.messages.push(message);
      } else {
        thread.messages[at] = message;
      }
    }
    this.touch(thread);
  }

  async removeMessages(threadId: string, messageIds: string[]): Promise<void> {
    this.sweep();
    const thread = this.visible(threadId);
    if (!thread) return;
    const drop = new Set(messageIds);
    thread.messages = thread.messages.filter((message) => !drop.has(message.id));
    this.touch(thread);
  }

  async loadSummaries(threadId: string): Promise<ThreadSummary[]> {
    const thread = this.visible(threadId);
    return thread?.summaries?.slice() ?? [];
  }

  async saveSummary(threadId: string, summary: ThreadSummary): Promise<void> {
    // A thread that is gone has nothing to summarise; the summary goes with it.
    const thread = this.visible(threadId);
    if (!thread) return;
    thread.summaries = keepSummary(thread.summaries ?? [], summary);
  }

  /** Test seam, and a way for an app to drop a conversation on request. */
  delete(threadId: string): void {
    if (this.visible(threadId)) this.threads.delete(threadId);
  }

  get size(): number {
    return this.threads.size;
  }

  /** Drops expired threads, at most once a minute; every read and write calls it. */
  sweep(now = Date.now()): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [threadId, thread] of this.threads) {
      if (isExpired(thread, now)) {
        this.threads.delete(threadId);
      }
    }
  }

  /**
   * Deletes up to `limit` (default 500) expired threads now, as
   * `DatabaseAgentStore.sweepExpired` does (#1312). A view sweeps its scope
   * only. An expired thread is already unreadable before this runs.
   */
  async sweepExpired(options: { now?: number; limit?: number } = {}): Promise<ThreadSweepResult> {
    const now = options.now ?? Date.now();
    let left = Math.max(0, Math.floor(options.limit ?? 500));
    let deleted = 0;
    for (const [threadId, thread] of this.threads) {
      if (left === 0) break;
      if (this.scope !== null && thread.scope !== this.scope) continue;
      if (isExpired(thread, now)) {
        this.threads.delete(threadId);
        deleted += 1;
        left -= 1;
      }
    }
    return { deleted };
  }
}

function isExpired(thread: Thread, now: number) {
  return thread.expiresAt !== null && now >= thread.expiresAt;
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
