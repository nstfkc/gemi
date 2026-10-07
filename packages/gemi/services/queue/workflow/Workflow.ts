import { app } from "../../../foundation/app";
import { QueueManager } from "../QueueManager";
import type { Step } from "./Step";
import type { StepRunStatus, WorkflowRunStatus } from "./WorkflowStore";

/** The arguments `start` takes: `run`'s, after `step`. */
export type WorkflowArgs<T extends Workflow> = Parameters<T["run"]> extends [
  any,
  ...infer Rest,
]
  ? Rest
  : never;

/** What `Workflow.find` resolves to. Times are epoch milliseconds. */
export type WorkflowStatus = {
  id: string;
  /** The workflow class's `static name`. */
  name: string;
  status: WorkflowRunStatus;
  /** The `run` arguments after `step`. */
  args: unknown[];
  /** The key of the step it is on, or `null`. */
  currentStep: string | null;
  /** 0 to 1, as `step.progress` last set it; 1 once completed. */
  progress: number;
  /** What `run` returned, once completed. */
  result: unknown;
  /** Why it failed; for a cancelled one, why `onCancel` failed. */
  error: string | null;
  /** Every step recorded so far, in the order they were first reached. */
  steps: WorkflowStepStatus[];
  createdAt: number;
  updatedAt: number;
};

export type WorkflowStepStatus = {
  key: string;
  status: StepRunStatus;
  /** Attempts started; `step.run` only. */
  attempt: number;
  error: string | null;
  /** The batch a `step.batch` dispatched. */
  batchId: string | null;
  /** The batch's progress, 0 to 1, for a `step.batch`. */
  progress?: number;
  /** When a sleep ends, a wait times out, or a retry is due. */
  wakeAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
};

/**
 * A durable workflow (#846): a `run` method made of steps, which survives
 * restarts and deploys, sleeps and waits without holding a process, and can
 * be cancelled.
 *
 * ```ts
 * export class ImportSiteWorkflow extends Workflow {
 *   static name = "ImportSiteWorkflow";
 *
 *   async run(step: Step, importId: string) {
 *     const pages = await step.run("discover", () => crawl(importId));
 *     const chosen = await step.waitFor<string[]>("pages-chosen", { timeout: "7d" });
 *     await step.run("charge", (ctx) => charge(importId, ctx.idempotencyKey), { attempts: 1 });
 *     const builds = await step.batch("build", BuildPageJob,
 *       chosen.map((id) => [id, importId] as const), { allowFailures: true });
 *     await step.sleep("settle", "30s");
 *     return step.run("report", () => report(importId, builds.failedJobIds));
 *   }
 *
 *   async onCancel(step: Step, importId: string) {
 *     await step.run("refund", () => refundUnbuilt(importId));
 *   }
 * }
 * ```
 *
 * ### How it runs
 *
 * Each pass calls `run` from the top, inside an internal queue job (a
 * *tick*), so leases, heartbeats and crash recovery are the queue's. A step
 * whose result is stored returns it without running; the first one without
 * one runs and its result is stored before the code goes on. A step that
 * cannot finish now (a sleep, a wait, a batch, a retry with a delay) ends the
 * pass, and a later tick picks it up. **Code outside the steps runs again on
 * every pass**, so it must be cheap and give the same answer each time: put
 * anything with a side effect, anything slow and anything random or
 * time-dependent inside `step.run`.
 *
 * Step keys are the identity of a step: unique within the workflow, and the
 * same on every pass. Adding or removing a step between deploys is safe; a
 * renamed step runs again.
 */
export class Workflow {
  static name = "unset";

  /**
   * The workflow's body. Its return value, as JSON, is the workflow's
   * `result`. A throw that escapes it fails the workflow.
   */
  run(_step: Step, ..._args: any[]): unknown {
    throw new Error(`The workflow ${(this.constructor as typeof Workflow).name} has no run method.`);
  }

  /**
   * Runs once after `Workflow.cancel`, in place of `run`, with the same
   * arguments: the place to undo what the steps did. Its steps are memoized
   * like `run`'s (use keys of their own), so it may sleep or retry too.
   */
  onCancel(_step: Step, ..._args: any[]): unknown {
    return undefined;
  }

  /**
   * Starts a workflow and resolves to its id. The workflow and its first tick
   * are recorded in one atomic write. Inside an ORM transaction it belongs to
   * the transaction, as a dispatch does: recorded with it, or held until it
   * commits and dropped if it rolls back.
   */
  static start<T extends Workflow>(
    this: new () => T,
    ...args: WorkflowArgs<T>
  ): Promise<string> {
    return app(QueueManager).workflows.start(this as unknown as WorkflowClass, args);
  }

  /**
   * Delivers `payload` to the workflow's `step.waitFor(key)`, and resolves to
   * whether it was taken: `false` for an unknown or ended workflow, and for a
   * key that was already signalled. A signal that arrives before the workflow
   * reaches its `waitFor` is kept until it does.
   */
  static signal(id: string, key: string, payload?: unknown): Promise<boolean> {
    return app(QueueManager).workflows.signal(id, key, payload);
  }

  /** The workflow's status, or `null` for an unknown id. */
  static find(id: string): Promise<WorkflowStatus | null> {
    return app(QueueManager).workflows.find(id);
  }

  /**
   * Cancels a workflow that has not ended, and resolves to whether it did.
   * A running `step.batch` is cancelled with it, a running `step.run` is told
   * through `ctx.signal`, and `onCancel` then runs once.
   */
  static cancel(id: string): Promise<boolean> {
    return app(QueueManager).workflows.cancel(id);
  }
}

export type WorkflowClass = (new () => Workflow) & { name: string };
