import { app } from "../../../foundation/app";
import { QueueManager } from "../QueueManager";
import type { EachProblem, Step } from "./Step";
import type { ChangeFeedResponse, StreamOptions } from "../../change-feed/stream";
import type { WorkflowUpdate } from "./wire";

/** The arguments `start` takes: `run`'s, after `step`. */
export type WorkflowArgs<T extends Workflow> = Parameters<T["run"]> extends [
  any,
  ...infer Rest,
]
  ? Rest
  : never;

/** What `Workflow.find` resolves to: the workflow's update, with its arguments and result. */
export type WorkflowStatus = WorkflowUpdate & {
  /** The `run` arguments after `step`. */
  args: unknown[];
  /** What `run` returned, once completed. */
  result: unknown;
};

export type { WorkflowStepStatus, WorkflowUpdate } from "./wire";

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

  /**
   * The items of the `step.each` under `key` that failed or were skipped
   * (or only those of `status`), by index, from just after the index
   * `after`, at most `limit` (default 100, at most 1000). Page through them
   * by passing the last index as `after`.
   */
  static items(
    id: string,
    key: string,
    options: { status?: "failed" | "skipped"; after?: number; limit?: number } = {},
  ): Promise<EachProblem[]> {
    return app(QueueManager).workflows.items(id, key, options);
  }

  /** The ChangeFeed channel a workflow's changes are published to: `gemi:workflow:<id>`. */
  static channel(id: string): string {
    return app(QueueManager).workflows.channel(id);
  }

  /**
   * An SSE response following workflow `id`, for `useWorkflow`. Each event's
   * `data` is a `WorkflowUpdate`: the status without `args` and `result`.
   * Authorise the read first, as for any route. Resumes from
   * `Last-Event-ID`, or `options.cursor` (`Workflow.cursor(id)`).
   */
  static stream(
    request: { rawRequest: Request } | Request,
    id: string,
    options: StreamOptions = {},
  ): ChangeFeedResponse<WorkflowUpdate> {
    return app(QueueManager).workflows.stream(request, id, options);
  }

  /** A cursor at the workflow's channel head, for a view that read it to hand its client. */
  static cursor(id: string): Promise<string> {
    return app(QueueManager).workflows.cursor(id);
  }

  /**
   * Follows workflow `id` on the server: yields it as it is now, then each
   * newer update, and ends after the one that ended it.
   */
  static subscribe(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<WorkflowUpdate, void, undefined> {
    return app(QueueManager).workflows.subscribe(id, options);
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

  /**
   * Pauses a workflow that has not ended, and resolves to whether it did. No
   * new step starts: a running `step.run` finishes and is recorded, a
   * `step.each` lets the items in flight finish and takes no more, and the
   * workflow then waits as `paused`, holding no queue slot, until `resume`.
   * Signals and batches that arrive meanwhile are kept. It can still be
   * cancelled.
   */
  static pause(id: string): Promise<boolean> {
    return app(QueueManager).workflows.pause(id);
  }

  /** Resumes a paused workflow where it stopped, and resolves to whether it was paused. */
  static resume(id: string): Promise<boolean> {
    return app(QueueManager).workflows.resume(id);
  }
}

export type WorkflowClass = (new () => Workflow) & { name: string };
