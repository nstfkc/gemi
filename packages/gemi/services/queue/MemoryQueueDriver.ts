import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueJob,
  JobFailure,
  JobRelease,
  QueueDriver,
} from "./QueueDriver";

type Entry = {
  job: ClaimedJob;
  /** Waiting: when it becomes due. Leased: when the lease runs out. */
  until: number;
  leased: boolean;
  /** Tie-break for `until`, so jobs that became claimable together stay FIFO. */
  seq: number;
};

/**
 * The default driver: a Map in this process's memory.
 *
 * **Everything in it is lost when the process exits.** A job that is waiting,
 * one waiting out a retry's backoff, and one halfway through `run` all vanish
 * with the process, and no hook fires for any of them — `Job.dispatch()`
 * resolved long ago, so nothing upstream is told. A deploy, a scale-in or a
 * crash is enough. Use it for development, tests, and work that is safe to
 * lose; anything that is not needs a driver backed by storage that outlives
 * the process.
 *
 * It implements the whole claim contract anyway — leases, reclaim on expiry,
 * stale-claim rejection — rather than the subset one process strictly needs.
 * That keeps it a faithful stand-in for a persistent driver in tests, and lets
 * the shared contract suite run against it unchanged. A lease can only lapse
 * here if the event loop was blocked for longer than the visibility timeout,
 * since the manager heartbeats every job it is running.
 *
 * It ignores `registered` in `claim` and hands out every name. Nothing but
 * this process can run its jobs, so a name this process does not know will
 * not be known by anyone, and the manager dead-letters it at once with a line
 * saying so; filtered out, it would wait here unseen until the process exited.
 *
 * One timer at most, for the next moment something becomes claimable, and it
 * is unref'd: a queue with nothing due does not hold the process open, and
 * neither does one waiting out a backoff — the same way the queue never has.
 */
export class MemoryQueueDriver implements QueueDriver {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private seq = 0;

  /** Jobs waiting to be claimed, including ones not yet due. */
  get waiting(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (!entry.leased) count++;
    return count;
  }

  /** Jobs currently claimed and not yet reported on. */
  get leased(): number {
    return this.entries.size - this.waiting;
  }

  async enqueue({ name, args, delayMs = 0 }: EnqueueJob): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.entries.set(id, {
      job: { id, name, args, attempt: 0, createdAt: now },
      until: now + Math.max(0, delayMs),
      leased: false,
      seq: this.seq++,
    });
    this.changed();
    return id;
  }

  async claim(limit: number, options: ClaimOptions): Promise<ClaimedJob[]> {
    const now = Date.now();
    const due = [...this.entries.values()]
      .filter((entry) => entry.until <= now)
      .sort((a, b) => a.until - b.until || a.seq - b.seq)
      .slice(0, Math.max(0, limit));

    for (const entry of due) {
      entry.job = { ...entry.job, attempt: entry.job.attempt + 1 };
      entry.leased = true;
      entry.until = now + options.visibilityTimeoutMs;
    }
    if (due.length > 0) this.schedule();

    // Copies, so a caller holding one cannot move the record underneath us.
    return due.map((entry) => ({ ...entry.job }));
  }

  async complete(job: ClaimedJob): Promise<void> {
    if (!this.current(job)) return;
    this.entries.delete(job.id);
    this.schedule();
  }

  async fail(job: ClaimedJob, failure: JobFailure): Promise<void> {
    const entry = this.current(job);
    if (!entry) return;

    if (failure.retryInMs === null) {
      this.entries.delete(job.id);
      this.schedule();
      return;
    }

    entry.leased = false;
    entry.until = Date.now() + Math.max(0, failure.retryInMs);
    entry.seq = this.seq++;
    this.changed();
  }

  async release(job: ClaimedJob, release: JobRelease): Promise<void> {
    const entry = this.current(job);
    if (!entry) return;

    entry.job = { ...entry.job, attempt: entry.job.attempt - 1 };
    entry.leased = false;
    entry.until = Date.now() + Math.max(0, release.retryInMs);
    entry.seq = this.seq++;
    this.changed();
  }

  async heartbeat(jobs: ClaimedJob[], options: ClaimOptions): Promise<void> {
    const until = Date.now() + options.visibilityTimeoutMs;
    for (const job of jobs) {
      const entry = this.current(job);
      if (entry) entry.until = until;
    }
    this.schedule();
  }

  subscribe(wake: () => void): () => void {
    this.listeners.add(wake);
    return () => void this.listeners.delete(wake);
  }

  /**
   * The entry for a report, if the report is about the claim that currently
   * holds it. A stale claimer — one whose lease lapsed and was re-issued —
   * gets nothing, so its late `complete` cannot end the newer claim.
   */
  private current(job: ClaimedJob): Entry | undefined {
    const entry = this.entries.get(job.id);
    if (!entry || !entry.leased || entry.job.attempt !== job.attempt) {
      return undefined;
    }
    return entry;
  }

  private changed() {
    this.schedule();
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.until <= now) {
        this.wake();
        return;
      }
    }
  }

  private wake() {
    for (const listener of [...this.listeners]) listener();
  }

  /** Points the one timer at the next moment something becomes claimable. */
  private schedule() {
    const now = Date.now();
    let next = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.until > now && entry.until < next) next = entry.until;
    }
    if (next === this.timerAt) return;

    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = next;
    if (next === Infinity) return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      this.changed();
    }, next - now);
    this.timer.unref?.();
  }
}
