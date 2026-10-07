/**
 * The bookkeeping of a job batch, shared by every driver so that the rules for
 * when a batch is cancelled and which callbacks run are written once.
 *
 * A driver keeps a `BatchRecord` per batch and calls these functions while it
 * holds that record exclusively: inside the transaction that also ends the job
 * (the database driver, with the batch row locked), or synchronously (the
 * memory driver). Everything here is pure; the driver writes what comes back,
 * and enqueues the callback jobs `settle` returns in the same step, which is
 * what makes each callback run exactly once.
 *
 * The rules:
 *
 * - Every job of the batch ends exactly once as `succeeded`, `failed` (it was
 *   dead-lettered) or `cancelled` (it never ran to the end because the batch was
 *   cancelled). `pending` counts the ones that have not ended yet.
 * - `catch` is due at the first failure or cancellation, whichever comes first.
 * - Without `allowFailures`, the first failure cancels the batch: the jobs still
 *   waiting are ended as `cancelled` at once, and running ones see it through
 *   `this.batch.cancelled()`.
 * - Once `pending` reaches 0 the batch is finished: `then` is due when it was
 *   not cancelled and nothing failed (or `allowFailures` is set), and `finally`
 *   is always due.
 */

/** A job and the arguments to dispatch it with: what `Job.with(...)` returns. */
export type JobCall = {
  /** The job's registered name: its class's `static name`. */
  name: string;
  /** The `run` arguments, before the batch status is appended. */
  args: unknown[];
};

export type BatchCallbacks = {
  then?: JobCall;
  catch?: JobCall;
  finally?: JobCall;
};

/** What `Job.findBatch` resolves to, and the last argument a batch callback gets. */
export type BatchStatus = {
  id: string;
  /** The `name` given to `dispatchBatch`, or `null`. */
  name: string | null;
  /** How many jobs the batch was dispatched with. */
  total: number;
  /** Jobs that have not ended yet: waiting, running, or waiting out a retry. */
  pending: number;
  succeeded: number;
  /** Jobs that were dead-lettered. */
  failed: number;
  /** Jobs that ended without running to the end because the batch was cancelled. */
  cancelled: number;
  /** The ids of the dead-lettered jobs, in the order they failed. */
  failedJobIds: string[];
  /**
   * 0 to 1: the ended jobs plus the share each running job reported with
   * `this.progress()`, over `total`. 1 for a batch of no jobs.
   */
  progress: number;
  /** When the batch was cancelled, in epoch milliseconds, or `null`. */
  cancelledAt: number | null;
  /** When its last job ended, in epoch milliseconds, or `null` while it runs. */
  finishedAt: number | null;
  createdAt: number;
};

/** What a driver stores per batch. */
export type BatchRecord = Omit<BatchStatus, "progress"> & {
  allowFailures: boolean;
  callbacks: BatchCallbacks;
};

/** How one job of a batch ended. */
export type BatchOutcome = "succeeded" | "failed" | "cancelled";

/** The callback jobs to enqueue, their arguments already serialised. */
export type BatchCallbackJob = { name: string; args: string };

export function newBatchRecord(batch: {
  id: string;
  name: string | null;
  total: number;
  allowFailures: boolean;
  callbacks: BatchCallbacks;
  now: number;
}): BatchRecord {
  return {
    id: batch.id,
    name: batch.name,
    total: batch.total,
    pending: batch.total,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    failedJobIds: [],
    cancelledAt: null,
    finishedAt: null,
    createdAt: batch.now,
    allowFailures: batch.allowFailures,
    callbacks: batch.callbacks,
  };
}

/** Counts one job's end. A batch with nothing pending is left as it is. */
export function countOutcome(
  record: BatchRecord,
  outcome: BatchOutcome,
  jobId: string,
): BatchRecord {
  if (record.pending <= 0) return record;
  const next = { ...record, pending: record.pending - 1 };
  if (outcome === "succeeded") next.succeeded++;
  else if (outcome === "cancelled") next.cancelled++;
  else {
    next.failed++;
    next.failedJobIds = [...record.failedJobIds, jobId];
  }
  return next;
}

/**
 * Whether going from `prev` to `next` is the failure that cancels the batch:
 * its first, without `allowFailures`, in a batch not already cancelled.
 */
export function cancelsBatch(prev: BatchRecord, next: BatchRecord): boolean {
  return (
    !next.allowFailures &&
    next.cancelledAt === null &&
    next.finishedAt === null &&
    next.failed > prev.failed
  );
}

/**
 * Marks the batch cancelled, counting the `waiting` jobs the driver has just
 * ended as `cancelled`.
 */
export function markCancelled(record: BatchRecord, now: number, waiting: number): BatchRecord {
  const ended = Math.min(Math.max(0, waiting), record.pending);
  return {
    ...record,
    cancelledAt: record.cancelledAt ?? now,
    pending: record.pending - ended,
    cancelled: record.cancelled + ended,
  };
}

/**
 * Finishes the batch when nothing is pending, and says which callbacks became
 * due between `prev` and `next`. Each callback's arguments are its own followed
 * by the batch's status as it stands after this step.
 */
export function settle(
  prev: BatchRecord,
  next: BatchRecord,
  now: number,
): { record: BatchRecord; calls: BatchCallbackJob[] } {
  let record = next;
  const due: JobCall[] = [];
  const callbacks = next.callbacks;

  const wasClean = prev.failed === 0 && prev.cancelledAt === null;
  const isClean = next.failed === 0 && next.cancelledAt === null;
  if (wasClean && !isClean && callbacks.catch) due.push(callbacks.catch);

  if (next.pending === 0 && next.finishedAt === null) {
    record = { ...next, finishedAt: now };
    const succeeded = next.cancelledAt === null && (next.failed === 0 || next.allowFailures);
    if (succeeded && callbacks.then) due.push(callbacks.then);
    if (callbacks.finally) due.push(callbacks.finally);
  }

  const status = statusOf(record);
  return {
    record,
    calls: due.map((call) => ({
      name: call.name,
      args: JSON.stringify([...call.args, status]),
    })),
  };
}

/**
 * The status of a batch. `running` is the sum of the progress the batch's
 * unfinished jobs have reported, each 0 to 1.
 */
export function statusOf(record: BatchRecord, running = 0): BatchStatus {
  const { allowFailures: _allowFailures, callbacks: _callbacks, ...status } = record;
  const ended = record.total - record.pending;
  const progress =
    record.total === 0 ? 1 : Math.min(1, Math.max(0, (ended + Math.max(0, running)) / record.total));
  return { ...status, failedJobIds: [...record.failedJobIds], progress };
}

/** A progress value as stored: a finite number clamped to 0..1. */
export function clampProgress(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`A job's progress is a number from 0 to 1; got ${String(value)}.`);
  }
  return Math.min(1, Math.max(0, value));
}
