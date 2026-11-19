// What a workflow's status looks like on the wire, between `Workflow.stream`
// and `useWorkflow`. Kept free of runtime imports so the browser build can
// name it.

/**
 * Where a workflow stands.
 *
 * - `running`: a tick is running it, or one is queued to.
 * - `sleeping`: waiting for a `step.sleep` or a step's retry backoff.
 * - `waiting`: waiting for a signal (`step.waitFor`) or a batch (`step.batch`).
 * - `paused`: `Workflow.pause` stopped it; nothing runs until `Workflow.resume`.
 * - `cancelling`: `cancel` was accepted, and `onCancel` has not finished yet.
 * - `completed`, `failed`, `cancelled`: final.
 */
export type WorkflowRunStatus =
  | "running"
  | "sleeping"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

/**
 * Where one step stands. `signalled` is a signal that arrived before its
 * `step.waitFor`, kept until the workflow gets there. `iterating` is a
 * `step.each` that has items left.
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
  | "batching"
  | "iterating";

/** How far a `step.each` is. */
export type EachProgress = {
  total: number;
  /** Items that ended: `succeeded + skipped + failed`. */
  done: number;
  succeeded: number;
  skipped: number;
  failed: number;
};

/** One step, as `Workflow.find` and the workflow's stream show it. Times are epoch milliseconds. */
export type WorkflowStepStatus = {
  key: string;
  status: StepRunStatus;
  /** Attempts started; `step.run` only. */
  attempt: number;
  error: string | null;
  /** The batch a `step.batch` dispatched. */
  batchId: string | null;
  /**
   * 0 to 1: the batch's progress for a `step.batch`, or the share of items
   * that have ended for a `step.each`.
   */
  progress?: number;
  /** How far a `step.each` is. */
  items?: EachProgress;
  /** When a sleep ends, a wait times out, or a retry is due. */
  wakeAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
};

/**
 * What a workflow's channel publishes on every change, and what
 * `useWorkflow` returns: its status without `args` and `result`, which can
 * hold what a browser must not see.
 */
export type WorkflowUpdate = {
  id: string;
  /** The workflow class's `static name`. */
  name: string;
  status: WorkflowRunStatus;
  /** The key of the step it is on, or `null`. */
  currentStep: string | null;
  /** 0 to 1, as `step.progress` or a running `step.each` last set it; 1 once completed. */
  progress: number;
  /** Why it failed; for a cancelled one, why `onCancel` failed. */
  error: string | null;
  /** Every step recorded so far, in the order they were first reached. */
  steps: WorkflowStepStatus[];
  createdAt: number;
  /** When it last changed: of two updates, the later one has the larger `updatedAt`. */
  updatedAt: number;
};

/** Whether a workflow has ended: `completed`, `failed` or `cancelled`. */
export function workflowEnded(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
