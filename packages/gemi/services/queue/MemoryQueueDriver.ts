import {
  type BatchOutcome,
  type BatchRecord,
  type BatchStatus,
  cancelsBatch,
  clampProgress,
  countOutcome,
  markCancelled,
  newBatchRecord,
  settle,
  statusOf,
} from "./batch";
import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueBatch,
  EnqueueJob,
  JobFailure,
  JobRelease,
  QueueDriver,
} from "./QueueDriver";
import { MemoryWorkflowStore } from "./workflow/MemoryWorkflowStore";
import type { WorkflowStore } from "./workflow/WorkflowStore";

type Entry = {
  job: ClaimedJob;
  /** Waiting: when it becomes due. Leased: when the lease runs out. */
  until: number;
  leased: boolean;
  /** Tie-break for `until`, so jobs that became claimable together stay FIFO. */
  seq: number;
  /** What a job of a batch last reported with `this.progress()`. */
  progress: number;
};

/**
 * How long a finished batch is kept for `findBatch`. Nothing else removes
 * one, and a long-running process would otherwise keep every batch it ever
 * ran.
 */
const FINISHED_BATCH_TTL = 24 * 60 * 60_000;

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
 * Batches are kept in a Map beside the jobs, and a finished one for a day.
 * Everything a batch does happens synchronously inside the call that causes
 * it, so the counters and the callbacks need no further care here.
 *
 * One timer at most, for the next moment something becomes claimable, and it
 * is unref'd: a queue with nothing due does not hold the process open, and
 * neither does one waiting out a backoff — the same way the queue never has.
 */
export class MemoryQueueDriver implements QueueDriver {
  private entries = new Map<string, Entry>();
  private batches = new Map<string, BatchRecord>();
  private workflows: MemoryWorkflowStore | undefined;
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

  async enqueue(job: EnqueueJob): Promise<string> {
    const id = this.add(job);
    this.changed();
    return id;
  }

  private add(
    { name, args, delayMs = 0, id = crypto.randomUUID() }: EnqueueJob,
    batchId?: string,
  ): string {
    const now = Date.now();
    this.entries.set(id, {
      job: {
        id,
        name,
        args,
        attempt: 0,
        createdAt: now,
        ...(batchId === undefined ? {} : { batchId }),
      },
      until: now + Math.max(0, delayMs),
      leased: false,
      seq: this.seq++,
      progress: 0,
    });
    return id;
  }

  async enqueueBatch(batch: EnqueueBatch): Promise<void> {
    this.recordBatch(batch);
  }

  /** `enqueueBatch`, synchronously, for the workflow store too. */
  private recordBatch(batch: EnqueueBatch) {
    const now = Date.now();
    this.forgetFinishedBatches(now);
    const record = newBatchRecord({ ...batch, total: batch.args.length, now });
    for (const args of batch.args) this.add({ name: batch.job, args }, batch.id);
    // A batch of no jobs is finished as soon as it exists.
    const { record: settled, calls } = settle(record, record, now);
    this.batches.set(batch.id, settled);
    for (const call of calls) this.add(call);
    this.changed();
  }

  async findBatch(id: string, options: { progress?: boolean } = {}): Promise<BatchStatus | null> {
    const record = this.batches.get(id);
    if (!record) return null;
    if (options.progress === false || record.pending === 0) return statusOf(record);
    let running = 0;
    for (const entry of this.entries.values()) {
      if (entry.job.batchId === id) running += entry.progress;
    }
    return statusOf(record, running);
  }

  async cancelBatch(id: string): Promise<boolean> {
    return this.cancelBatchNow(id);
  }

  private cancelBatchNow(id: string): boolean {
    const prev = this.batches.get(id);
    if (!prev || prev.finishedAt !== null || prev.cancelledAt !== null) return false;
    const now = Date.now();
    const next = markCancelled(prev, now, this.cancelWaiting(id));
    this.save(prev, next, now);
    this.changed();
    return true;
  }

  /**
   * Workflows (#846), kept in memory beside the jobs and lost with them. The
   * store's writes, ticks and batches included, happen synchronously here.
   */
  workflowStore(): WorkflowStore {
    this.workflows ??= new MemoryWorkflowStore({
      enqueue: (job) => {
        this.add(job);
        this.changed();
      },
      enqueueBatch: (batch) => this.recordBatch(batch),
      cancelBatch: (id) => void this.cancelBatchNow(id),
    });
    return this.workflows;
  }

  async reportProgress(job: ClaimedJob, progress: number): Promise<void> {
    const entry = this.current(job);
    if (entry) entry.progress = clampProgress(progress);
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
    const entry = this.current(job);
    if (!entry) return;
    this.entries.delete(job.id);
    this.count(entry, "succeeded");
    this.schedule();
  }

  async fail(job: ClaimedJob, failure: JobFailure): Promise<void> {
    const entry = this.current(job);
    if (!entry) return;

    // A retry of a job whose batch was cancelled meanwhile would only be
    // ended as cancelled when it was next claimed; ended here instead.
    const batch = entry.job.batchId === undefined ? undefined : this.batches.get(entry.job.batchId);
    const cancelled =
      failure.cancelled === true || (failure.retryInMs !== null && batch?.cancelledAt != null);

    if (failure.retryInMs === null || cancelled) {
      this.entries.delete(job.id);
      this.count(entry, cancelled ? "cancelled" : "failed");
      this.schedule();
      return;
    }

    entry.leased = false;
    entry.until = Date.now() + Math.max(0, failure.retryInMs);
    entry.seq = this.seq++;
    entry.progress = 0;
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

  /** Counts a job's end against its batch, if it has one. */
  private count(entry: Entry, outcome: BatchOutcome) {
    const batchId = entry.job.batchId;
    if (batchId === undefined) return;
    const prev = this.batches.get(batchId);
    if (!prev) return;
    const now = Date.now();
    let next = countOutcome(prev, outcome, entry.job.id);
    if (cancelsBatch(prev, next)) {
      next = markCancelled(next, now, this.cancelWaiting(batchId));
    }
    this.save(prev, next, now);
    this.changed();
  }

  /** Stores the batch's new state and enqueues the callbacks it made due. */
  private save(prev: BatchRecord, next: BatchRecord, now: number) {
    const { record, calls } = settle(prev, next, now);
    this.batches.set(record.id, record);
    for (const call of calls) this.add(call);
  }

  /** Drops the batch's waiting jobs, and says how many there were. */
  private cancelWaiting(batchId: string): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.job.batchId === batchId && !entry.leased) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  private forgetFinishedBatches(now: number) {
    for (const [id, record] of this.batches) {
      if (record.finishedAt !== null && now - record.finishedAt > FINISHED_BATCH_TTL) {
        this.batches.delete(id);
      }
    }
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
