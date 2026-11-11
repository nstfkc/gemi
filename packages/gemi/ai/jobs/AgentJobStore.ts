import type { AgentError, Usage } from "../types";

/**
 * Where a background job stands (#461).
 *
 * `waiting` while it waits for the jobs it starts after (`after`), then
 * `running` until something settles it; `ok` and `error` are final. A job
 * moves out of `running` once, by compare-and-set (`AgentJobStore.transition`),
 * so a queue worker, a provider's webhook, a poller and the deadline sweep can
 * all race to settle the same job and exactly one of them wins. A cancelled
 * job is `error` with `error.code` `"cancelled"`.
 */
export type AgentJobState = "waiting" | "running" | "ok" | "error";

/** Whether a job has settled (`ok` or `error`), as opposed to waiting or running. */
export function isSettled(state: AgentJobState): boolean {
  return state === "ok" || state === "error";
}

/** What a waiting job's queue dispatch will carry once it may start. */
export type QueuedJobStart = {
  /** The job's own arguments. */
  args: unknown;
  /** Its deadline, counted from when it starts rather than from when it was made. */
  deadlineMs: number;
};

/**
 * One background job, as the job store keeps it.
 *
 * The record is the job's state, and it is NOT the tool result. The tool
 * result in the thread says `running` and points here by `id`; the controller
 * renders the record's current state over it whenever it loads the thread (see
 * `overlayJobs`). The record is kept apart from the messages because a live
 * run writes whole messages to the store, and a job settling during that run
 * would race those writes and lose.
 */
export type AgentJobRecord = {
  /** `ajob_…`. Handed to the app (`JobHandle.id`) to settle a tracked job. */
  id: string;
  threadId: string;
  /** The run whose tool started the job. */
  runId: string;
  /**
   * The tool call whose result this job settles. `""` (with `runId` `""`) for
   * a job started from server code with `AgentJobs.start` or `AgentJobs.track`,
   * which settles no tool call.
   */
  toolCallId: string;
  /** The tool's name, or the `name` given to `AgentJobs.start` (default the job's class name). */
  toolName: string;
  /** The `runOwner` of the run that started it, or `null` for an anonymous run. */
  owner: string | null;
  /** The `AgentJob` class's queue name, or `null` for a job made with `track`. */
  job: string | null;
  /**
   * What the tool said about the job when it started it: what the model and
   * the UI see while it runs. Server-owned, and kept small by the tool.
   */
  summary?: unknown;
  state: AgentJobState;
  /** The settled output, on `ok`. */
  output?: unknown;
  /** Why it failed, on `error`. Already redacted: this is what the model reads. */
  error?: AgentError;
  /** What the job spent on model and image calls. Counted on the turn that started it. */
  usage?: Usage;
  /**
   * Set when the job's tool result never reached the thread: the run died
   * after the job started and before the result was stored. The job still
   * runs and settles; nothing in the thread shows it.
   */
  orphaned?: true;
  /**
   * The attachment scope key of the run that started the job, so the job's
   * `attachments` are the ones the tool would have had. `null` when the run
   * had none.
   */
  attachmentScope: string | null;
  /**
   * The jobs this one starts after (#1222): it is `waiting` until each has
   * settled `ok`, and is cancelled when one of them fails or is cancelled.
   */
  after?: string[];
  /**
   * A label the jobs started together share. `AgentJobs.onSettledBatch`
   * reports a settled job once every other unsettled job of its batch builds
   * on it, so the batch is reported together.
   */
  batch?: string;
  /** A waiting job's queue dispatch, kept until it starts. */
  queued?: QueuedJobStart;
  /**
   * Messages sent with `AgentJobs.message` that the job has not taken yet.
   * On a settled job, the ones it never took (the work ended first).
   */
  inbox?: string[];
  /** What the job last saved with `job.checkpoint(value)`, for its next attempt. */
  checkpoint?: unknown;
  /** Epoch milliseconds, on the store's clock. */
  createdAt: number;
  updatedAt: number;
  /** When the deadline sweep fails the job if it is still running. */
  deadlineAt: number;
  settledAt?: number;
};

/** What `create` is given: the record minus what the store stamps. */
export type NewAgentJobRecord = Omit<
  AgentJobRecord,
  "state" | "createdAt" | "updatedAt" | "deadlineAt" | "settledAt" | "inbox" | "checkpoint"
> & {
  /** How long from now the job may run, in milliseconds. */
  deadlineMs: number;
  /** `waiting` for a job with unsettled `after` jobs. Default `running`. */
  state?: "running" | "waiting";
};

/** The fields a transition may write. `id`, the thread and the call never change. */
export type AgentJobUpdate = Partial<
  Pick<
    AgentJobRecord,
    "state" | "output" | "error" | "usage" | "orphaned" | "settledAt" | "checkpoint"
  >
> & {
  /** Moves the deadline to this many milliseconds from now, on the store's clock. */
  deadlineMs?: number;
};

/**
 * Where background jobs live.
 *
 * `MemoryAgentJobStore` is the default and is not durable. `DatabaseAgentJobStore`
 * keeps them in a table. An app that already has a jobs table can implement
 * this over it.
 */
export interface AgentJobStore {
  /** Writes a new `running` record and returns it as stored. */
  create(job: NewAgentJobRecord): Promise<AgentJobRecord>;
  get(id: string): Promise<AgentJobRecord | null>;
  /**
   * A thread's jobs, newest first. `states` filters, `limit` bounds. Each
   * record is a copy the caller may keep.
   */
  listForThread(
    threadId: string,
    options?: { states?: AgentJobState[]; limit?: number },
  ): Promise<AgentJobRecord[]>;
  /**
   * Compare-and-set: applies `to` only when the job's state is one of `from`,
   * and answers whether it did. Bumps `updatedAt`, and stamps `settledAt` when
   * `to.state` moves the job out of `running`.
   */
  transition(id: string, from: AgentJobState[], to: AgentJobUpdate): Promise<boolean>;
  /** Running jobs whose `deadlineAt` is at or before `now`, oldest deadline first. */
  overdue(now: number, limit: number): Promise<AgentJobRecord[]>;
  /**
   * The store's clock, in epoch milliseconds. The deadline sweep compares
   * `deadlineAt` against this rather than the process's clock. Optional: a
   * store without one is compared against `Date.now()`.
   */
  now?(): Promise<number>;
  /**
   * Runs `fn` in a transaction, so `ctx.jobs.start` writes the record and
   * queues the job together: both or neither. Optional: without it the record
   * is written first, and a dispatch that fails then fails the record.
   */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Waiting jobs whose `after` names `id` (#1222). Needed for `after`; a store
   * without it refuses jobs with `after`.
   */
  waitingOn?(id: string): Promise<AgentJobRecord[]>;
  /** Waiting jobs, oldest first, for the sweep to start or cancel the ones it can. */
  waiting?(limit: number): Promise<AgentJobRecord[]>;
  /** The jobs of a batch (`batch`), oldest first. Needed for `onSettledBatch`'s batches. */
  listBatch?(batch: string): Promise<AgentJobRecord[]>;
  /**
   * Adds a message to a waiting or running job's `inbox`, and answers whether
   * it did (false once the job has settled). Needed for `AgentJobs.message`.
   */
  appendInbox?(id: string, text: string): Promise<boolean>;
  /** Empties a job's `inbox` and answers what was in it, oldest first. */
  takeInbox?(id: string): Promise<string[]>;
}

/** How many settled jobs the memory store keeps per thread before dropping the oldest. */
const MEMORY_SETTLED_PER_THREAD = 200;

/**
 * Jobs in a map, for as long as the process lives.
 *
 * NOT DURABLE, like `MemoryAgentStore`: a restart loses every record, and a
 * job that was running is then lost too. The tool result that pointed at it
 * reads as a lost job on the next turn. It is the default so that jobs work in
 * development and tests without a table; use `DatabaseAgentJobStore` in
 * production.
 *
 * It only works when the queue runs the jobs in this same process (the memory
 * queue driver, or a database driver claiming here), since a worker in another
 * process has a map of its own.
 */
export class MemoryAgentJobStore implements AgentJobStore {
  private jobs = new Map<string, AgentJobRecord>();

  async create(job: NewAgentJobRecord): Promise<AgentJobRecord> {
    if (this.jobs.has(job.id)) {
      throw new Error(`A background job with the id ${job.id} already exists.`);
    }
    const now = Date.now();
    const { deadlineMs, state, ...fields } = job;
    const record: AgentJobRecord = {
      ...structuredClone(fields),
      state: state ?? "running",
      createdAt: now,
      updatedAt: now,
      deadlineAt: now + deadlineMs,
    };
    this.jobs.set(record.id, record);
    this.trim(record.threadId);
    return structuredClone(record);
  }

  async get(id: string): Promise<AgentJobRecord | null> {
    const record = this.jobs.get(id);
    return record ? structuredClone(record) : null;
  }

  async listForThread(
    threadId: string,
    options: { states?: AgentJobState[]; limit?: number } = {},
  ): Promise<AgentJobRecord[]> {
    const out: AgentJobRecord[] = [];
    for (const record of this.jobs.values()) {
      if (record.threadId !== threadId) continue;
      if (options.states && !options.states.includes(record.state)) continue;
      out.push(record);
    }
    out.sort(newestFirst);
    return (options.limit === undefined ? out : out.slice(0, options.limit)).map((record) =>
      structuredClone(record),
    );
  }

  async transition(id: string, from: AgentJobState[], to: AgentJobUpdate): Promise<boolean> {
    const record = this.jobs.get(id);
    if (!record || !from.includes(record.state)) return false;
    // Cloned in before anything is assigned, so an output that is not plain
    // data fails the transition rather than half-applying it.
    const { deadlineMs, ...update } = structuredClone(to);
    const now = Date.now();
    Object.assign(record, update, { updatedAt: now });
    if (deadlineMs !== undefined) record.deadlineAt = now + deadlineMs;
    if (update.state && isSettled(update.state) && record.settledAt === undefined) {
      record.settledAt = update.settledAt ?? now;
    }
    return true;
  }

  async waitingOn(id: string): Promise<AgentJobRecord[]> {
    return [...this.jobs.values()]
      .filter((record) => record.state === "waiting" && record.after?.includes(id))
      .sort(oldestFirst)
      .map((record) => structuredClone(record));
  }

  async waiting(limit: number): Promise<AgentJobRecord[]> {
    return [...this.jobs.values()]
      .filter((record) => record.state === "waiting")
      .sort(oldestFirst)
      .slice(0, Math.max(0, limit))
      .map((record) => structuredClone(record));
  }

  async listBatch(batch: string): Promise<AgentJobRecord[]> {
    return [...this.jobs.values()]
      .filter((record) => record.batch === batch)
      .sort(oldestFirst)
      .map((record) => structuredClone(record));
  }

  async appendInbox(id: string, text: string): Promise<boolean> {
    const record = this.jobs.get(id);
    if (!record || isSettled(record.state)) return false;
    record.inbox = [...(record.inbox ?? []), text];
    record.updatedAt = Date.now();
    return true;
  }

  async takeInbox(id: string): Promise<string[]> {
    const record = this.jobs.get(id);
    if (!record?.inbox?.length) return [];
    const taken = record.inbox;
    delete record.inbox;
    return taken;
  }

  async overdue(now: number, limit: number): Promise<AgentJobRecord[]> {
    const out: AgentJobRecord[] = [];
    for (const record of this.jobs.values()) {
      if (record.state === "running" && record.deadlineAt <= now) out.push(record);
    }
    out.sort((a, b) => a.deadlineAt - b.deadlineAt);
    return out.slice(0, Math.max(0, limit)).map((record) => structuredClone(record));
  }

  async now(): Promise<number> {
    return Date.now();
  }

  /** Bounds a long-lived thread: running jobs are never dropped, settled ones oldest first. */
  private trim(threadId: string): void {
    const settled = [...this.jobs.values()]
      .filter((record) => record.threadId === threadId && isSettled(record.state))
      .sort(newestFirst);
    for (const record of settled.slice(MEMORY_SETTLED_PER_THREAD)) this.jobs.delete(record.id);
  }
}

/** Oldest first, with the id as a tie-break so the order is stable. */
export function oldestFirst(a: AgentJobRecord, b: AgentJobRecord): number {
  return -newestFirst(a, b);
}

/** Newest first, with the id as a tie-break so the order is stable. */
export function newestFirst(a: AgentJobRecord, b: AgentJobRecord): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
