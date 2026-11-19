import type { EnqueueBatch, EnqueueJob } from "../QueueDriver";
import {
  type AcquireResult,
  type ItemRecord,
  type ItemRunStatus,
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
  /** Item rows of `step.each`, by workflow, then step key. */
  private items = new Map<string, Map<string, ItemRows>>();

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
    options: { owner?: string; key?: string; allSteps?: boolean; items?: string },
    decide: (snapshot: {
      workflow: WorkflowRecord;
      step: StepRecord | null;
      steps: StepRecord[];
      items: ItemRecord[];
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
      items:
        options.items === undefined
          ? []
          : this.itemsOf(id, options.items, ["running", "retrying"], -1, Infinity),
      now,
    });

    if (change.step) {
      const previous = steps.get(change.step.key);
      // A Map keeps insertion order, so a step keeps its first-recorded place.
      steps.set(change.step.key, { ...change.step, createdAt: previous?.createdAt ?? now, updatedAt: now });
    }
    if (change.items) {
      const rows = this.rowsOf(id, change.items.step);
      for (const index of change.items.delete ?? []) {
        rows.all.delete(index);
        rows.open.delete(index);
      }
      for (const item of [...(change.items.insert ?? []), ...(change.items.update ?? [])]) {
        const previous = rows.all.get(item.index);
        rows.all.set(item.index, {
          ...item,
          step: change.items.step,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
        if (item.status === "running" || item.status === "retrying") rows.open.add(item.index);
        else rows.open.delete(item.index);
      }
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
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }

  async listItems(
    workflowId: string,
    step: string,
    options: { statuses: ItemRunStatus[]; after?: number; limit: number },
  ): Promise<ItemRecord[]> {
    return this.itemsOf(workflowId, step, options.statuses, options.after ?? -1, options.limit);
  }

  private itemsOf(
    id: string,
    step: string,
    statuses: ItemRunStatus[],
    after: number,
    limit: number,
  ): ItemRecord[] {
    const rows = this.items.get(id)?.get(step);
    if (!rows) return [];
    const open = statuses.every((status) => status === "running" || status === "retrying");
    const indexes = open ? [...rows.open] : [...rows.all.keys()];
    const found: ItemRecord[] = [];
    for (const index of indexes.sort((a, b) => a - b)) {
      if (index <= after) continue;
      const item = rows.all.get(index)!;
      if (!statuses.includes(item.status)) continue;
      found.push({ ...item });
      if (found.length >= limit) break;
    }
    return found;
  }

  private rowsOf(id: string, step: string): ItemRows {
    let steps = this.items.get(id);
    if (!steps) this.items.set(id, (steps = new Map()));
    let rows = steps.get(step);
    if (!rows) steps.set(step, (rows = { all: new Map(), open: new Set() }));
    return rows;
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

/** One `step.each`'s rows, and which of them are in flight or retrying. */
type ItemRows = { all: Map<number, ItemRecord>; open: Set<number> };
