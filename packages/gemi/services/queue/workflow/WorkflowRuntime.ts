import { deferUntilCommit } from "../../../orm/context";
import { Job } from "../Job";
import type { QueueManager } from "../QueueManager";
import {
  Step,
  WorkflowSuspended,
  decode,
  describe,
  encode,
} from "./Step";
import type { WorkflowClass, WorkflowStatus } from "./Workflow";
import {
  WORKFLOW_TICK_JOB,
  type WorkflowChange,
  WorkflowLeaseLostError,
  type WorkflowRecord,
  type WorkflowRunStatus,
  type WorkflowStore,
} from "./WorkflowStore";

const ENDED: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled"];

/** How often a running `step.run` checks whether its workflow was cancelled. */
const CANCEL_CHECK_MS = 1000;

type Outcome =
  | { kind: "completed"; result: string | null }
  | { kind: "failed"; error: string }
  | { kind: "suspended" };

/**
 * The queue's half of workflows: the registry of workflow classes, what
 * `Workflow.start`, `signal`, `find` and `cancel` do, and the tick.
 *
 * ### The tick
 *
 * A workflow advances only inside its tick job, which takes the workflow
 * from the store for a lease (the queue's `visibilityTimeout`, renewed while
 * it runs), runs one pass of `run`, and lets go with the outcome written in
 * the same step. Every write of the pass is fenced by that hold, so a tick
 * that lost it (it was too slow and another took over) changes nothing.
 *
 * A tick that finds the workflow held by another is dropped, after marking
 * the workflow so the holder enqueues a fresh tick when it lets go: a signal
 * that lands mid-pass is never lost, and two passes of one workflow never
 * overlap. A tick that failed or died holds the workflow under its job's id,
 * so its own retry takes it straight back.
 */
export class WorkflowRuntime {
  private registry: Record<string, WorkflowClass> = {};
  private storeInstance: WorkflowStore | undefined;
  private tickClass: (new () => Job) | undefined;
  private readonly reportedNames = new Set<string>();

  constructor(private readonly queue: QueueManager) {}

  /** The workflow classes this process can run, by `static name`. */
  get workflows(): Readonly<Record<string, WorkflowClass>> {
    return this.registry;
  }

  /** Replaces the registry. The first class to claim a name wins. */
  use(workflows: readonly WorkflowClass[]) {
    this.registry = {};
    for (const workflow of workflows) {
      if (workflow.name === "unset" || !workflow.name) {
        console.error(
          `A workflow class has no \`static name\`, so it was not registered. Add one.`,
        );
        continue;
      }
      if (this.registry[workflow.name]) {
        console.error(
          `Two workflows are named "${workflow.name}" — the first is registered ` +
            `and this one is not. A workflow's name is its key in storage. Rename one.`,
        );
        continue;
      }
      this.registry[workflow.name] = workflow;
    }
  }

  /** The internal job a workflow's passes run in, one class per manager. */
  get tickJob(): new () => Job {
    this.tickClass ??= tickJobFor(this);
    return this.tickClass;
  }

  get store(): WorkflowStore {
    if (!this.storeInstance) {
      const store = this.queue.driver.workflowStore?.();
      if (!store || !this.queue.driver.enqueueBatch) {
        throw new Error(
          `This queue's driver does not support workflows. The memory and ` +
            `database drivers do.`,
        );
      }
      this.storeInstance = store;
    }
    return this.storeInstance;
  }

  start(workflow: WorkflowClass, args: unknown[]): Promise<string> {
    if (workflow.name === "unset" || !workflow.name) {
      throw new Error("Cannot start a workflow with no name");
    }
    const store = this.store;
    const record = {
      id: Bun.randomUUIDv7(),
      name: workflow.name,
      args: encode(args, `The arguments of ${workflow.name}`) ?? "[]",
    };
    const wake = () => this.queue.claimSoon();

    // As `QueueManager.push`: on the caller's transaction when the store
    // joins it, otherwise held until it commits.
    const joins = store.joinsTransaction?.() === true;
    if (!joins) {
      const held = deferUntilCommit(() =>
        store.create(record).then(wake, (error: unknown) => {
          console.error(
            `[gemi] The queue could not record the workflow ${workflow.name}, which ` +
              `was held until its transaction committed. The transaction stays ` +
              `committed; the workflow did not start.`,
            error,
          );
        }),
      );
      if (held) return Promise.resolve(record.id);
    }
    const written = store.create(record);
    const wakeAtCommit = joins && deferUntilCommit(wake);
    return written.then(() => {
      if (!wakeAtCommit) wake();
      return record.id;
    });
  }

  async signal(id: string, key: string, payload?: unknown): Promise<boolean> {
    if (typeof key !== "string" || key.length === 0 || key.length > 191) {
      throw new TypeError(`A signal key is a string of 1 to 191 characters.`);
    }
    const output = encode(payload, `The payload of signal "${key}"`);
    const taken = await this.store.update(id, { key }, ({ workflow, step, now }) => {
      if (ENDED.includes(workflow.status) || workflow.status === "cancelling") {
        return { result: false };
      }
      if (!step) {
        return {
          result: true,
          step: {
            workflowId: id,
            key,
            status: "signalled",
            attempt: 0,
            output,
            error: null,
            batchId: null,
            wakeAt: null,
            startedAt: null,
            finishedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        };
      }
      if (step.status !== "waiting") return { result: false };
      return {
        result: true,
        step: { ...step, status: "signalled", output, wakeAt: step.wakeAt, finishedAt: now },
        tick: { delayMs: 0 },
      };
    });
    if (taken) this.queue.claimSoon();
    return taken === true;
  }

  async cancel(id: string): Promise<boolean> {
    const cancelled = await this.store.update(id, { allSteps: true }, ({ workflow, steps }) => {
      if (ENDED.includes(workflow.status) || workflow.status === "cancelling") {
        return { result: false };
      }
      return {
        result: true,
        workflow: { status: "cancelling" },
        cancelBatches: steps
          .filter((step) => step.status === "batching" && step.batchId !== null)
          .map((step) => step.batchId!),
        tick: { delayMs: 0 },
      };
    });
    if (cancelled) this.queue.claimSoon();
    return cancelled === true;
  }

  async find(id: string): Promise<WorkflowStatus | null> {
    const state = await this.store.find(id);
    if (!state) return null;
    const { workflow, steps } = state;
    let args: unknown[] = [];
    try {
      args = JSON.parse(workflow.args) as unknown[];
    } catch {}
    return {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      args,
      currentStep: workflow.currentStep,
      progress: workflow.progress,
      result: safeDecode(workflow.result),
      error: workflow.error,
      steps: await Promise.all(
        steps.map(async (step) => {
          const status = {
            key: step.key,
            status: step.status,
            attempt: step.attempt,
            error: step.error,
            batchId: step.batchId,
            wakeAt: step.wakeAt,
            startedAt: step.startedAt,
            finishedAt: step.finishedAt,
          };
          if (step.batchId === null) return status;
          const batch = await this.queue.driver.findBatch?.(step.batchId);
          return batch ? { ...status, progress: batch.progress } : status;
        }),
      ),
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
  }

  /** One pass of the workflow `id`, run by its tick job. */
  async tick(id: string, job: Job): Promise<void> {
    const store = this.store;
    const claimed = job.$claimed;
    const owner = claimed
      ? `${claimed.id}:${claimed.attempt}`
      : `${crypto.randomUUID()}:1`;
    const lease = Math.max(1, this.queue.config.visibilityTimeout);
    const acquired = await store.acquire(id, owner, lease);
    if (acquired.kind !== "acquired") return;
    const { workflow } = acquired;

    const letGo = (change: Partial<WorkflowChange<undefined>> = {}) =>
      store
        .update(id, { owner }, () => ({ ...change, result: undefined, unlock: true }))
        .then(() => this.queue.claimSoon())
        .catch((error) => {
          if (!(error instanceof WorkflowLeaseLostError)) throw error;
        });

    if (ENDED.includes(workflow.status)) return letGo();

    const Class = this.registry[workflow.name];
    if (!Class) return this.unknown(workflow, job, letGo);

    let args: unknown[];
    try {
      args = JSON.parse(workflow.args) as unknown[];
    } catch (error) {
      return letGo({
        workflow: { status: "failed", error: `The arguments are not JSON: ${describe(error)}` },
      });
    }

    const renew = setInterval(
      () => {
        store.renew(id, owner, lease).catch((error) => {
          console.error(`[gemi] Could not extend the hold on workflow ${id}.`, error);
        });
      },
      Math.max(1, Math.floor(lease / 3)),
    );
    renew.unref?.();

    const cancelling = workflow.status === "cancelling";
    const step = new Step({
      workflowId: id,
      owner,
      store,
      steps: acquired.steps,
      cancelling,
      findBatch: (batchId) =>
        this.queue.driver.findBatch?.(batchId, { progress: false }) ?? Promise.resolve(null),
      buildBatch: (batchJob, tuples, options) =>
        this.queue.buildBatch(
          batchJob,
          tuples.map((tuple) => JSON.stringify(tuple)),
          {
            name: options.name,
            allowFailures: options.allowFailures,
            finally: { name: WORKFLOW_TICK_JOB, args: [id] },
          },
        ),
      scheduled: () => this.queue.claimSoon(),
      cancelCheckMs: CANCEL_CHECK_MS,
    });

    try {
      let outcome: Outcome;
      try {
        const instance = new Class();
        const value = await (cancelling
          ? instance.onCancel(step, ...args)
          : instance.run(step, ...args));
        outcome = step.suspension
          ? { kind: "suspended" }
          : {
              kind: "completed",
              result: cancelling ? null : encode(value, `The result of ${workflow.name}`),
            };
      } catch (error) {
        outcome =
          step.suspension || error instanceof WorkflowSuspended
            ? { kind: "suspended" }
            : { kind: "failed", error: describe(error) };
        if (error instanceof WorkflowLeaseLostError) step.lost = true;
      }
      // A step the code did not await (or one that ran beside a sleep in a
      // `Promise.all`) is still writing; it finishes inside this pass.
      await step.settled();
      if (step.lost) return;
      // One of those suspended the workflow after `run` had returned: it is
      // not done until that step is.
      if (outcome.kind === "completed" && step.suspension) outcome = { kind: "suspended" };

      await store.update(id, { owner }, ({ workflow: current, now }) =>
        this.finish(current, outcome, step, cancelling, now),
      );
      this.queue.claimSoon();
    } catch (error) {
      if (error instanceof WorkflowLeaseLostError) return;
      throw error;
    } finally {
      clearInterval(renew);
    }
  }

  /** The tick's last write: the pass's outcome, and letting go. */
  private finish(
    current: WorkflowRecord,
    outcome: Outcome,
    step: Step,
    cancelling: boolean,
    now: number,
  ): WorkflowChange<undefined> {
    const change: WorkflowChange<undefined> = { result: undefined, unlock: true };

    // Cancelled during this pass of `run`: `onCancel` is next, whatever the
    // pass came to.
    if (current.status === "cancelling" && !cancelling) {
      return { ...change, tick: { delayMs: 0 } };
    }

    if (outcome.kind === "completed") {
      return {
        ...change,
        workflow: cancelling
          ? { status: "cancelled", currentStep: null, wakeAt: null }
          : {
              status: "completed",
              result: outcome.result,
              progress: 1,
              currentStep: null,
              wakeAt: null,
              error: null,
            },
      };
    }
    if (outcome.kind === "failed") {
      return {
        ...change,
        workflow: { status: cancelling ? "cancelled" : "failed", error: outcome.error, wakeAt: null },
      };
    }

    const suspension = step.suspension ?? { status: "waiting" as const, wakes: [] };
    const next: WorkflowChange<undefined> = {
      ...change,
      workflow: {
        status: cancelling ? "cancelling" : suspension.status,
        currentStep: step.current ?? current.currentStep,
      },
    };
    if (suspension.wakes.length > 0) {
      const wakeAt = Math.min(...suspension.wakes);
      // A tick already scheduled no later than this one wakes the workflow
      // in time, and schedules this one itself; a second would only run the
      // pass twice.
      const scheduled =
        current.wakeAt !== null && current.wakeAt > now && current.wakeAt <= wakeAt;
      if (!scheduled) {
        next.tick = { delayMs: Math.max(0, wakeAt - now) };
        next.workflow!.wakeAt = wakeAt;
      }
    }
    return next;
  }

  /**
   * A tick for a workflow this process has no class for. During a
   * blue/green ramp that is usually one only the other release has, so on a
   * shared driver it goes back for another replica until `unknownJobGrace`
   * has passed since the workflow started; then it fails.
   */
  private async unknown(
    workflow: WorkflowRecord,
    job: Job,
    letGo: (change?: Partial<WorkflowChange<undefined>>) => Promise<void>,
  ) {
    const age = Date.now() - workflow.createdAt;
    if (this.queue.durable && age < this.queue.config.unknownJobGrace) {
      if (!this.reportedNames.has(workflow.name)) {
        this.reportedNames.add(workflow.name);
        console.error(
          `Left workflow "${workflow.name}" for another replica: nothing is ` +
            `registered here under that name.`,
        );
      }
      await letGo();
      job.release(Math.round(this.queue.config.pollInterval * (1 + Math.random())));
      return;
    }
    console.error(
      `Failed workflow ${workflow.id}: nothing is registered under the name ` +
        `"${workflow.name}". If the class exists, it was not discovered: check ` +
        `that it is under the queue slice's workflowsDir (app/workflows by ` +
        `default), or list it in app/config/queue.ts.`,
    );
    await letGo({
      workflow: {
        status: "failed",
        error: `No workflow is registered under the name "${workflow.name}".`,
      },
    });
  }

  /**
   * The tick job ran out of attempts, which only a store that stayed
   * unreachable causes. Fails the workflow if it still can, so it does not
   * sit in `running` with nothing left to advance it.
   */
  /** @internal */
  tickDeadLettered(id: string, error: Error) {
    console.error(`[gemi] The tick of workflow ${id} was dead-lettered.`, error);
    void this.store
      .update(id, {}, ({ workflow }) =>
        ENDED.includes(workflow.status)
          ? { result: undefined }
          : {
              result: undefined,
              workflow: {
                status: "failed",
                error: `Its tick job was dead-lettered: ${error.message}`,
              },
              unlock: true,
            },
      )
      .catch(() => {});
  }
}

/** The internal job a workflow's passes run in, bound to one runtime. */
function tickJobFor(runtime: WorkflowRuntime): new () => Job {
  return class WorkflowTickJob extends Job {
    static name = WORKFLOW_TICK_JOB;
    // A tick fails only when the store cannot be reached (a workflow's own
    // errors are recorded, not thrown), so it keeps trying for a while rather
    // than leaving the workflow stuck.
    maxAttempts = 20;
    backoff = [1000, 5000, 15000, 30000, 60000];
    async run(id: string) {
      await runtime.tick(id, this);
    }
    onDeadletter(error: Error, id: string) {
      runtime.tickDeadLettered(id, error);
    }
  };
}

function safeDecode(output: string | null): unknown {
  try {
    return decode(output);
  } catch {
    return output;
  }
}
