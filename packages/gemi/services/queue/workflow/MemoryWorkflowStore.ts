import type { EnqueueBatch, EnqueueJob } from "../QueueDriver";
import {
  type AcquireResult,
  type StepRecord,
  WORKFLOW_TICK_JOB,
  type WorkflowChange,
  WorkflowLeaseLostError,
  sameTick,
  type WorkflowRecord,
  type WorkflowState,
  type WorkflowStore,
} from "./WorkflowStore";

/** What the memory driver lends its workflow store: its own writes, done synchronously. */
export type MemoryQueueWrites = {
  enqueue(job: EnqueueJob): void;
  enqueueBatch(batch: EnqueueBatch): void;
  cancelBatch(id: string): void;
};

/** How long an ended workflow is kept for `find`. */
const FINISHED_WORKFLOW_TTL = 24 * 60 * 60_000;

/**
 * Workflows in this process's memory, beside the memory driver's jobs, and
 * lost with them when the process exits. Every change happens synchronously
 * inside the call that makes it, so it is atomic without further care.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  private workflows = new Map<string, WorkflowRecord>();
  private steps = new Map<string, Map<string, StepRecord>>();

  constructor(private readonly queue: MemoryQueueWrites) {}

  async create(workflow: { id: string; name: string; args: string }): Promise<void> {
    if (this.workflows.has(workflow.id)) {
      throw new Error(`A workflow with the id ${workflow.id} already exists.`);
    }
    // Nothing else removes an ended workflow, and a long-running process
    // would otherwise keep every one it ever ran.
    void this.prune(FINISHED_WORKFLOW_TTL);
    const now = Date.now();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: "running",
      currentStep: null,
      progress: 0,
      result: null,
      error: null,
      wakeAt: null,
      lockedBy: null,
      lockedUntil: null,
      retick: false,
      createdAt: now,
      updatedAt: now,
    });
    this.steps.set(workflow.id, new Map());
    this.tick(workflow.id, 0);
  }

  async find(id: string, options: { steps?: boolean } = {}): Promise<WorkflowState | null> {
    const workflow = this.workflows.get(id);
    if (!workflow) return null;
    return {
      workflow: { ...workflow },
      steps: options.steps === false ? [] : this.stepsOf(id),
    };
  }

  async acquire(id: string, owner: string, leaseMs: number): Promise<AcquireResult> {
    const workflow = this.workflows.get(id);
    if (!workflow) return { kind: "missing" };
    const now = Date.now();
    if (
      workflow.lockedBy !== null &&
      !sameTick(workflow.lockedBy, owner) &&
      (workflow.lockedUntil ?? 0) > now
    ) {
      workflow.retick = true;
      return { kind: "busy" };
    }
    workflow.lockedBy = owner;
    workflow.lockedUntil = now + leaseMs;
    workflow.retick = false;
    return { kind: "acquired", workflow: { ...workflow }, steps: this.stepsOf(id) };
  }

  async renew(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const workflow = this.workflows.get(id);
    if (!workflow || workflow.lockedBy !== owner) return false;
    workflow.lockedUntil = Date.now() + leaseMs;
    return true;
  }

  async update<T>(
    id: string,
    options: { owner?: string; key?: string; allSteps?: boolean },
    decide: (snapshot: {
      workflow: WorkflowRecord;
      step: StepRecord | null;
      steps: StepRecord[];
      now: number;
    }) => WorkflowChange<T>,
  ): Promise<T | undefined> {
    const workflow = this.workflows.get(id);
    if (!workflow) return undefined;
    if (options.owner !== undefined && workflow.lockedBy !== options.owner) {
      throw new WorkflowLeaseLostError(id);
    }
    const steps = this.steps.get(id)!;
    const current = options.key === undefined ? undefined : steps.get(options.key);
    const now = Date.now();
    const change = decide({
      workflow: { ...workflow },
      step: current ? { ...current } : null,
      steps: options.allSteps ? this.stepsOf(id) : [],
      now,
    });

    if (change.step) {
      const previous = steps.get(change.step.key);
      // A Map keeps insertion order, so a step keeps its first-recorded place.
      steps.set(change.step.key, { ...change.step, createdAt: previous?.createdAt ?? now, updatedAt: now });
    }
    if (change.batch) this.queue.enqueueBatch(change.batch);
    for (const batchId of change.cancelBatches ?? []) this.queue.cancelBatch(batchId);
    if (change.workflow) Object.assign(workflow, change.workflow);
    workflow.updatedAt = now;
    if (change.tick) this.tick(id, change.tick.delayMs);
    if (change.unlock) {
      workflow.lockedBy = null;
      workflow.lockedUntil = null;
      if (workflow.retick) {
        workflow.retick = false;
        this.tick(id, 0);
      }
    }
    return change.result;
  }

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let count = 0;
    for (const [id, workflow] of this.workflows) {
      const ended = ["completed", "failed", "cancelled"].includes(workflow.status);
      if (ended && workflow.updatedAt <= cutoff) {
        this.workflows.delete(id);
        this.steps.delete(id);
        count++;
      }
    }
    return count;
  }

  private stepsOf(id: string): StepRecord[] {
    return [...(this.steps.get(id)?.values() ?? [])].map((step) => ({ ...step }));
  }

  private tick(id: string, delayMs: number) {
    this.queue.enqueue({
      name: WORKFLOW_TICK_JOB,
      args: JSON.stringify([id]),
      delayMs: Math.max(0, Math.round(delayMs)),
    });
  }
}
