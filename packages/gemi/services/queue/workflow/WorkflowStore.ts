/**
 * Where workflows are kept (#846), and the one atomic operation everything a
 * workflow does is built from.
 *
 * A store belongs to a queue driver (`QueueDriver.workflowStore`), because a
 * workflow's writes and the jobs they schedule must commit together: a step
 * that sleeps records the sleep and enqueues the tick that wakes it in one
 * step, and `step.batch` records the step and dispatches the batch in one
 * step, so a crash between the two can neither lose the wake-up nor fan out
 * twice. The memory driver does each change synchronously; the database driver
 * does it in a transaction that locks the workflow's row first.
 *
 * A store only keeps records. What a change means (when a step is done, when
 * a workflow sleeps) is decided by the runtime, in the `decide` callback of
 * `update`, while the store holds the workflow exclusively.
 */
import type { EnqueueBatch } from "../QueueDriver";

/** The registered name the internal tick job runs under. */
export const WORKFLOW_TICK_JOB = "gemi.WorkflowTick";

/**
 * The most a step's output, a signal's payload or a workflow's result may be,
 * as JSON, in bytes. Store an id for anything larger.
 */
export const WORKFLOW_OUTPUT_LIMIT = 256 * 1024;

/**
 * Where a workflow stands.
 *
 * - `running`: a tick is running it, or one is queued to.
 * - `sleeping`: waiting for a `step.sleep` or a step's retry backoff.
 * - `waiting`: waiting for a signal (`step.waitFor`) or a batch (`step.batch`).
 * - `cancelling`: `cancel` was accepted, and `onCancel` has not finished yet.
 * - `completed`, `failed`, `cancelled`: final.
 */
export type WorkflowRunStatus =
  | "running"
  | "sleeping"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

/**
 * Where one step stands. `signalled` is a signal that arrived before its
 * `step.waitFor`, kept until the workflow gets there.
 */
export type StepRunStatus =
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "sleeping"
  | "waiting"
  | "signalled"
  | "timed_out"
  | "batching";

/** A workflow's row. Times are epoch milliseconds. */
export type WorkflowRecord = {
  id: string;
  /** The workflow class's `static name`. */
  name: string;
  /** The `run` arguments after `step`, as JSON. */
  args: string;
  status: WorkflowRunStatus;
  /** The key of the step it is on, or `null`. */
  currentStep: string | null;
  /** 0 to 1, as `step.progress` last set it; 1 once completed. */
  progress: number;
  /** What `run` returned, as JSON, once completed. `null` for `undefined`. */
  result: string | null;
  error: string | null;
  /** When the next tick that was scheduled for a wake-up is due, or `null`. */
  wakeAt: number | null;
  /** The tick holding the workflow, and until when (on the store's clock). */
  lockedBy: string | null;
  lockedUntil: number | null;
  /** Another tick arrived while one held the workflow; see `update`'s `unlock`. */
  retick: boolean;
  createdAt: number;
  updatedAt: number;
};

/** A step's row, unique per workflow and key. */
export type StepRecord = {
  workflowId: string;
  key: string;
  status: StepRunStatus;
  /** Attempts started, counting from 1. */
  attempt: number;
  /** The step's result or the signal's payload, as JSON. `null` for `undefined`. */
  output: string | null;
  error: string | null;
  /** The batch a `step.batch` dispatched. */
  batchId: string | null;
  /** When a sleep ends, a wait times out, or a retry is due. */
  wakeAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** A workflow and its steps, in the order the steps were first recorded. */
export type WorkflowState = { workflow: WorkflowRecord; steps: StepRecord[] };

export type AcquireResult =
  | { kind: "missing" }
  /** Another tick holds it; `retick` is set, so that tick runs it again. */
  | { kind: "busy" }
  | ({ kind: "acquired" } & WorkflowState);

/** What `update`'s `decide` sees, read while the workflow is held. */
export type WorkflowSnapshot = {
  workflow: WorkflowRecord;
  /** The step `key` names, or `null` when there is none (or no key was given). */
  step: StepRecord | null;
  /** Every step, when `allSteps` was asked for; otherwise empty. */
  steps: StepRecord[];
  /** This process's clock, for the wake-up times the runtime computes. */
  now: number;
};

/** What `decide` wants written, all in the same atomic step. */
export type WorkflowChange<T> = {
  /** What `update` resolves to. */
  result: T;
  workflow?: Partial<
    Pick<
      WorkflowRecord,
      "status" | "currentStep" | "progress" | "result" | "error" | "wakeAt"
    >
  >;
  /** The step's new row: inserted, or replacing the one under its key. */
  step?: StepRecord;
  /** A batch to dispatch, as `QueueDriver.enqueueBatch` would. */
  batch?: EnqueueBatch;
  /** Batches to cancel, as `QueueDriver.cancelBatch` would. */
  cancelBatches?: string[];
  /** Enqueue a tick for this workflow, claimable after `delayMs`. */
  tick?: { delayMs: number };
  /**
   * Release the tick's hold on the workflow. When another tick arrived while
   * it was held (`retick`), a new tick is enqueued in the same step, so a
   * signal that landed mid-tick is never lost.
   */
  unlock?: boolean;
};

/**
 * Whether two holds are attempts of the same tick job. A tick holds the
 * workflow as `<tick job id>:<attempt>`, so a retry of a tick that failed or
 * died takes the workflow straight back instead of waiting out the lease,
 * and the earlier attempt's writes are refused from then on.
 */
export function sameTick(a: string, b: string): boolean {
  const job = (owner: string) => owner.slice(0, owner.lastIndexOf(":"));
  return job(a) === job(b);
}

export class WorkflowLeaseLostError extends Error {
  constructor(id: string) {
    super(
      `The tick running workflow ${id} lost its hold on it (another tick took ` +
        `it over after its lease ran out), so its writes were refused.`,
    );
    this.name = "WorkflowLeaseLostError";
  }
}

export interface WorkflowStore {
  /**
   * Records a new workflow and enqueues its first tick, in one atomic step.
   * Like `QueueDriver.enqueue`, a store that answers `joinsTransaction`
   * writes on the caller's ORM transaction.
   */
  create(workflow: { id: string; name: string; args: string }): Promise<void>;

  /** Whether `create` would write on the caller's open ORM transaction. */
  joinsTransaction?(): boolean;

  /** The workflow, and its steps unless `steps: false`, or `null`. */
  find(id: string, options?: { steps?: boolean }): Promise<WorkflowState | null>;

  /**
   * Takes the workflow for one tick, for `leaseMs` on the store's clock, and
   * returns its state. A workflow another tick holds under a live lease is
   * `busy`, and is marked to be ticked again when that tick lets go; one held
   * by an earlier attempt of the same tick job (see `sameTick`) is taken over.
   */
  acquire(id: string, owner: string, leaseMs: number): Promise<AcquireResult>;

  /** Extends the tick's lease, and resolves to whether it still held it. */
  renew(id: string, owner: string, leaseMs: number): Promise<boolean>;

  /**
   * Reads the workflow (and the step `key`, or every step with `allSteps`)
   * while holding it exclusively, calls `decide`, and writes what it returns,
   * all in one atomic step. With `owner`, the write is refused with a
   * `WorkflowLeaseLostError` unless that tick still holds the workflow.
   * Resolves to `undefined` for an unknown workflow.
   */
  update<T>(
    id: string,
    options: { owner?: string; key?: string; allSteps?: boolean },
    decide: (snapshot: WorkflowSnapshot) => WorkflowChange<T>,
  ): Promise<T | undefined>;

  /**
   * Deletes workflows that ended (completed, failed or cancelled) more than
   * `olderThanMs` ago, with their steps, and resolves to how many.
   */
  prune?(olderThanMs: number): Promise<number>;
}
