import type { AgentRun } from "../Agent";
import type { LiveRuns } from "../AgentController";
import type { AgentStreamEvent, AgentStreamFrame } from "../types";

/** Long enough that a refresh, a tab restore or a flaky mobile connection still
 *  lands on the tail; short enough that a finished run is not resident for the
 *  rest of the day. */
const DEFAULT_TTL_MS = 60 * 1000;

/**
 * How many frames are kept per run.
 *
 * The window has to be bounded or it is a memory leak with a long fuse: a
 * server that never restarts holding every token of every conversation it ever
 * streamed.
 *
 * It was 512 on the reasoning that a reattaching client only needs seconds of
 * catch-up. That is true of the *reattaching* client and false of the one that
 * never left: a frame is roughly a token, so 512 is a four-hundred-word answer,
 * and a reader that falls behind a longer one by more than that is cut off with
 * a 410 mid-stream. On a slow connection — the case reattachment exists for —
 * that is not exotic.
 *
 * 4096 covers essentially any single answer. It is affordable because of two
 * measured facts, and it would not have been before either:
 *
 *   - `drain` no longer copies the window per wake, so a reader costs the same
 *     whatever the window's size. Measured at 64 readers on a 2000-frame run:
 *     1106 ms of CPU at 4096 before, 425 ms after, and 468 ms at 512 — i.e. the
 *     size stopped being a term in the cost.
 *   - the entries are pointers to frames the run is holding anyway, so the
 *     window costs 8 bytes each, not the frame. Eight times more of them is
 *     ~28 KB per run, and a thousand concurrent runs is tens of megabytes.
 *
 * Both would change if the run's own buffer ever became bounded — then this
 * window owns the frames, and its size is their size.
 */
const DEFAULT_MAX_FRAMES = 4096;

/**
 * A cursor older than anything still buffered.
 *
 * Deliberately an error rather than "here is the tail I still have". A client
 * that asked for frame 12 and silently got frame 300 onwards has a transcript
 * with a hole in it and no way to know — it will render a half-message, or an
 * `awaiting-input` for a tool call it never saw. Saying so lets the client do
 * the only correct thing, which is to reload the thread from the store.
 */
export class FrameCursorEvictedError extends Error {
  readonly code = "frame_cursor_evicted";

  constructor(
    readonly runId: string,
    readonly requested: number,
    readonly oldest: number,
  ) {
    super(
      `Frame ${requested} of run ${runId} has been evicted; the oldest frame ` +
        `still buffered is ${oldest}. Reload the thread instead of resuming.`,
    );
  }
}

/**
 * No run under that id in *this* process.
 *
 * Which is the honest answer, and the one worth being loud about: the run may
 * well be alive on the box next door. See the note on `MemoryLiveRuns` — behind
 * a round-robin load balancer this is what a refresh hits roughly (n-1)/n of
 * the time, and an explicit miss is the difference between a bug someone finds
 * in an hour and one that presents as "reattach sometimes does nothing".
 */
export class LiveRunNotFoundError extends Error {
  readonly code = "live_run_not_found";

  constructor(readonly runId: string) {
    super(`No live run ${runId} in this process.`);
  }
}

export type RegisterParams = {
  threadId?: string;
  /**
   * The client's own name for this run, minted before the run had one.
   *
   * `runId` does not reach the client until `run-start`, and a stateless first
   * turn has no `threadId` either, so for the length of a network round trip
   * plus the provider's time to first token there is nothing for `/stop` to
   * name — which is exactly the window a user cancels in. `useChat` sends a
   * `clientRunId` with every turn it starts; recording it here is what makes
   * that window stoppable.
   */
  clientRunId?: string;
  /**
   * Called once per frame, in order, off the buffering path.
   *
   * The controller's `on*` hooks hang off this. It is a callback rather than a
   * second `run.frames()` subscription because every extra subscriber is
   * another consumer of a generator whose multi-subscriber behaviour we do not
   * own, and one pump is one thing to reason about.
   */
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  /** Reported failures: a hook that threw, or a run whose frame iterator did.
   *  Injectable so tests can assert on it instead of reading stderr. */
  onInternalError?: (error: unknown) => void;
};

type Entry = {
  run: AgentRun;
  threadId?: string;
  clientRunId?: string;
  /** A contiguous window of the run's frames, oldest first. */
  frames: AgentStreamFrame[];
  lastSeq: number;
  /**
   * The lowest `seq` still obtainable, or 0 while nothing has been dropped.
   *
   * Not derivable from `frames[0].seq`, which is what this used to compare
   * against. `seq` starts at 1, so a run that has evicted nothing still has an
   * oldest frame of 1, and a cursor of 0 — the "I have no transcript yet"
   * cursor that `replay` itself picks for a run registered but not yet pumped —
   * read as older than the buffer. A ten-frame run in a five-hundred-frame
   * window answered a refresh with 410, which is both false and unactionable:
   * refreshing right after sending is the case `/attach` exists to serve.
   */
  lostBefore: number;
  ended: boolean;
  evictAt: ReturnType<typeof setTimeout> | null;
  wake: Set<() => void>;
  /**
   * Bumped on every push and on the end.
   *
   * A reader cannot just park on "wake me when something happens": it suspends
   * at every `yield` while its consumer reads, and anything that arrives during
   * that suspension notifies an empty waiter set — so the reader parks *after*
   * the event it was waiting for and never hears another. The version it read
   * before scanning is what closes that window: if it moved, there is more to
   * scan and the wait is skipped.
   */
  version: number;
};

/**
 * The runs currently in flight in this process, and their recent frames.
 *
 * PER-PROCESS IS NOT AN IMPLEMENTATION SHORTCUT THAT A BETTER STORE FIXES. A
 * running generator lives in one process, and a second server cannot attach to
 * it — no amount of Redis moves an in-flight async iterator across a socket.
 * Reattachment therefore needs the request to land where the run is: one
 * server, sticky routing, or a proxy that forwards by `runId`. Worth saying out
 * loud, because the failure mode behind a round-robin load balancer is a
 * refresh that usually works.
 *
 * `find` and `replay` are built so that failure is an explicit miss — a 404
 * naming the run, a 410 naming the cursor — and never an SSE stream that opens,
 * says nothing and closes. An empty stream is indistinguishable from a run that
 * finished quietly, which is exactly the confusion this is supposed to avoid.
 */
export class MemoryLiveRuns implements LiveRuns {
  ttlMs: number;
  readonly maxFrames: number;

  private runs = new Map<string, Entry>();
  /** Thread to the most recently registered run for it. */
  private byThread = new Map<string, string>();
  /** The client's pre-`run-start` name for a run, to the run. */
  private byClientRun = new Map<string, string>();

  constructor(params: { ttlMs?: number; maxFrames?: number } = {}) {
    this.ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
    this.maxFrames = params.maxFrames ?? DEFAULT_MAX_FRAMES;
  }

  /**
   * Takes ownership of a run: starts buffering its frames and holds it until
   * `ttlMs` past the end.
   */
  register(run: AgentRun, params: RegisterParams = {}): void {
    const entry: Entry = {
      run: run as AgentRun,
      threadId: params.threadId,
      clientRunId: params.clientRunId,
      frames: [],
      lastSeq: -1,
      lostBefore: 0,
      ended: false,
      evictAt: null,
      wake: new Set(),
      version: 0,
    };
    this.runs.set(run.runId, entry);
    if (params.threadId) {
      this.byThread.set(params.threadId, run.runId);
    }
    if (params.clientRunId) {
      this.byClientRun.set(params.clientRunId, run.runId);
    }
    void this.pump(entry, params);
  }

  /**
   * The run a client named before the server had named it.
   *
   * Deliberately not folded into `find`, whose parameter is part of the
   * read-side `LiveRuns` interface an app may already implement — widening that
   * parameter would break every such implementation, and this lookup is only
   * ever asked by `/stop`.
   */
  findByClientRunId(clientRunId: string): string | null {
    const runId = this.byClientRun.get(clientRunId);
    return runId && this.runs.has(runId) ? runId : null;
  }

  /** What the client asks after a refresh: is anything still going here? */
  async find(params: { threadId: string }): Promise<{ runId: string; seq: number } | null> {
    const runId = this.byThread.get(params.threadId);
    if (!runId) {
      return null;
    }
    const entry = this.runs.get(runId);
    if (!entry) {
      return null;
    }
    // `seq` is the last frame emitted, not the next one: it is the same number
    // the transport puts in `Last-Event-ID`, so a client can compare the two
    // without knowing which end of the range each one means.
    return { runId, seq: entry.lastSeq };
  }

  get(runId: string): AgentRun | null {
    return this.runs.get(runId)?.run ?? null;
  }

  /**
   * The buffered frames from `from` onwards, followed by live ones until the
   * run ends.
   *
   * Throws before returning anything, so an evicted cursor and an unknown run
   * are still HTTP statuses rather than events on a stream that already
   * committed to a 200.
   *
   * `from` omitted means "start wherever you still can", not "start at 0".
   * These are genuinely different requests: a client that names a cursor is
   * telling us where its transcript ends, and handing it a later frame leaves
   * an invisible hole — that is the 410. A client with no cursor at all — the
   * browser reattaching on mount, which is the case `/attach` exists for — has
   * no transcript to put a hole in, and refusing it the tail because the run is
   * older than the buffer would 410 every run past `maxFrames`, i.e. every run
   * long enough to be worth reattaching to.
   */
  replay(runId: string, from?: number): AsyncIterable<AgentStreamFrame> {
    const entry = this.runs.get(runId);
    if (!entry) {
      throw new LiveRunNotFoundError(runId);
    }
    if (from !== undefined && from < entry.lostBefore) {
      throw new FrameCursorEvictedError(runId, from, entry.lostBefore);
    }
    const oldest = entry.frames[0]?.seq;
    // With nothing buffered — a run registered but not yet pumped — `lastSeq`
    // is -1 and this is 0, which is the same answer by another route.
    return this.drain(entry, runId, from ?? oldest ?? entry.lastSeq + 1);
  }

  /** Test seam: drops everything and cancels the pending eviction timers. */
  clear(): void {
    for (const entry of this.runs.values()) {
      if (entry.evictAt) {
        clearTimeout(entry.evictAt);
      }
      // Marked ended before waking: a reader parked on `wait` would otherwise
      // come back, find the entry unfinished, and park again forever.
      entry.ended = true;
      this.notify(entry);
    }
    this.runs.clear();
    this.byThread.clear();
    this.byClientRun.clear();
  }

  get size(): number {
    return this.runs.size;
  }

  private async pump(entry: Entry, params: RegisterParams): Promise<void> {
    // Hooks run on their own chain: they stay in order relative to each other,
    // and a slow one never stalls the buffer a reattaching client reads from.
    let hooks = Promise.resolve();
    try {
      for await (const frame of entry.run.frames()) {
        entry.frames.push(frame);
        entry.lastSeq = frame.seq;
        if (entry.frames.length > this.maxFrames) {
          const dropped = entry.frames.shift();
          if (dropped) entry.lostBefore = dropped.seq + 1;
        }
        this.notify(entry);
        const onEvent = params.onEvent;
        if (onEvent) {
          hooks = hooks
            .then(() => onEvent(frame.event))
            .catch((err) => {
              params.onInternalError?.(err);
            });
        }
      }
    } catch (err) {
      // The run's own iterator failed. There is nothing left to replay, so the
      // entry ends here; whoever is attached sees the stream close.
      params.onInternalError?.(err);
    } finally {
      entry.ended = true;
      this.notify(entry);
      // Eviction is scheduled off the ttl clock, BEFORE the hook chain is
      // awaited. `hooks` is app code — `onAwaitingInput` is documented as the
      // place to notify an approver, i.e. network I/O — and a `fetch` with no
      // timeout never rejects, it just never settles. Awaiting it first made
      // retention conditional on app code: one hanging hook pinned its entry,
      // its 512 frames, the run and everything the run closes over in the map
      // for the life of the process, and `find` kept answering with a run that
      // ended hours ago. Retention is this class's job and belongs on its own
      // clock. A hook still pending when the timer fires simply outlives the
      // entry, which is fine — it holds no reference the map needed.
      this.scheduleEviction(entry);
      await hooks;
    }
  }

  private async *drain(
    entry: Entry,
    runId: string,
    from: number,
  ): AsyncGenerator<AgentStreamFrame, void, void> {
    let cursor = from;
    while (true) {
      const seen = entry.version;
      // The window is contiguous and ordered, so a reader's position in it is
      // arithmetic, not a search. This used to copy the whole window on every
      // wake and scan it for frames past the cursor, which is O(window) per
      // frame per reader — invisible at a 512-frame cap and the reason the cap
      // could not be raised. Indexing makes the window's size stop mattering.
      for (;;) {
        if (cursor < entry.lostBefore) {
          // The window rolled past this reader mid-stream. Same reasoning as
          // the pre-flight check: a gap the client cannot see is worse than a
          // stream that stops and says why. Re-checked inside the loop rather
          // than once per wake, because a yield suspends this reader for as
          // long as its consumer takes and the pump keeps running.
          throw new FrameCursorEvictedError(runId, cursor, entry.lostBefore);
        }
        const frames = entry.frames;
        const oldest = frames[0]?.seq;
        if (oldest === undefined) {
          break;
        }
        // Clamped rather than treated as a gap: a cursor below the first seq
        // that ever existed is "from the beginning", not a lost position.
        const index = Math.max(0, cursor - oldest);
        if (index >= frames.length) {
          break;
        }
        const frame = frames[index]!;
        yield frame;
        cursor = frame.seq + 1;
      }
      if (entry.ended && cursor > entry.lastSeq) {
        return;
      }
      await this.wait(entry, seen);
    }
  }

  private wait(entry: Entry, seen: number): Promise<void> {
    if (entry.version !== seen) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => entry.wake.add(resolve));
  }

  private notify(entry: Entry): void {
    entry.version++;
    const waiters = Array.from(entry.wake);
    entry.wake.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  private scheduleEviction(entry: Entry): void {
    if (entry.evictAt) {
      return;
    }
    const timer = setTimeout(() => {
      const runId = entry.run.runId;
      this.runs.delete(runId);
      if (entry.threadId && this.byThread.get(entry.threadId) === runId) {
        this.byThread.delete(entry.threadId);
      }
      if (entry.clientRunId && this.byClientRun.get(entry.clientRunId) === runId) {
        this.byClientRun.delete(entry.clientRunId);
      }
      // Anyone still draining is holding an ended entry; wake them so they see
      // `ended` and finish rather than hanging on a promise nothing resolves.
      this.notify(entry);
    }, this.ttlMs);
    // A finished run must not be the reason a process stays up.
    (timer as { unref?: () => void }).unref?.();
    entry.evictAt = timer;
  }
}

/**
 * The process-wide default, shared by every `AgentController` that does not
 * bring its own. One map per process is the whole point — see the class note.
 */
export const liveRuns = new MemoryLiveRuns();
