/**
 * Tracked background runs (#908): the record, and where it is kept.
 *
 * A run is a small record with a status machine. Whoever does the work (a
 * queue job, a webhook, an agent job) moves it along; whoever waits for it (a
 * route, an MCP tool, another job, the browser) reads it. `RunManager` builds
 * the API on a store and publishes every change to the run's ChangeFeed
 * channel; a store only keeps records.
 */

/**
 * Where a run stands.
 *
 * - `pending`: recorded, and nothing has started it yet.
 * - `running`: started, or it reported progress.
 * - `completed`, `failed`, `cancelled`, `timed_out`: final. A run that ended
 *   never changes again.
 */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** The statuses a run ends in. */
export const FINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

/** The statuses a run can still move out of. */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["pending", "running"];

/** Whether `status` is final. */
export function isFinalRunStatus(status: RunStatus): boolean {
  return FINAL_RUN_STATUSES.includes(status);
}

/**
 * What a run last said about how far it got. Each report replaces the one
 * before it. Everything in it is JSON, and it is streamed to whoever follows
 * the run, so keep it small.
 */
export type RunProgress<P = unknown> = {
  /** 0 to 1. */
  fraction?: number;
  /** A line for a person: "Writing copy". */
  message?: string;
  /** Anything else, as JSON. */
  data?: P;
};

/**
 * Why a run did not complete. It is part of the record, which is streamed to
 * whoever follows the run, so it holds only what a user may read.
 */
export type RunError = {
  message: string;
  /** A machine-readable reason: `"deadline"`, `"cancelled"`, `"not_found"`… */
  code?: string;
  data?: unknown;
};

/** One run, as the store keeps it. Times are epoch milliseconds on the store's clock. */
export type RunRecord<R = unknown, P = unknown> = {
  /** `run_…`, unless `create` was given one. */
  id: string;
  /** What kind of work it is: `"page-build"`, `"site-import"`. */
  kind: string;
  /** What it works on, to find it again: `"site:42"`. */
  subject: string | null;
  /** Who started it, as the app names them: `"user:7"`. */
  owner: string | null;
  status: RunStatus;
  /** What the starter said about it, as JSON. Fixed once created. */
  meta: unknown;
  progress: RunProgress<P> | null;
  /** What it produced, once `completed`. */
  result: R | null;
  /** Why it ended, once `failed`, `cancelled` or `timed_out`. */
  error: RunError | null;
  /**
   * 1 when created, and one more for each change. Changes can reach a
   * follower out of order (two instances publishing at once), so a follower
   * keeps the record with the highest version it saw.
   */
  version: number;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  /** When the run times out if it has not ended, or `null` for never. */
  deadlineAt: number | null;
};

/** What a store's `create` is given. */
export type NewRunRecord = {
  id: string;
  kind: string;
  subject: string | null;
  owner: string | null;
  meta: unknown;
  /** `pending`, or `running` for a run recorded by the work itself. */
  status: "pending" | "running";
  /** How long from now the run may take, in milliseconds, or `null`. */
  deadlineMs: number | null;
};

/** The fields a transition may write. */
export type RunUpdate = {
  status?: RunStatus;
  progress?: RunProgress | null;
  result?: unknown;
  error?: RunError | null;
};

/** What `list` filters on. Every given field must match. */
export type RunFilter = {
  kind?: string;
  subject?: string;
  owner?: string;
  statuses?: readonly RunStatus[];
  /** At most this many, newest first. Default 50. */
  limit?: number;
};

/**
 * Where runs live.
 *
 * `MemoryRunStore` is the default and is not durable. `DatabaseRunStore`
 * keeps them in a table. An app may implement this over a table of its own.
 */
export interface RunStore {
  /** Writes a new run and returns it as stored. Rejects for an id already used. */
  create(run: NewRunRecord): Promise<RunRecord>;

  get(id: string): Promise<RunRecord | null>;

  /** Runs matching `filter`, newest first. */
  list(filter: RunFilter): Promise<RunRecord[]>;

  /**
   * Compare-and-set: applies `to` only when the run's status is one of
   * `from`, and resolves to the run as it is afterwards, or `null` when it
   * applied nothing. Bumps `version` and `updatedAt`; stamps `startedAt` the
   * first time the status becomes `running` (or final without having run),
   * and `finishedAt` when it becomes final.
   */
  transition(id: string, from: readonly RunStatus[], to: RunUpdate): Promise<RunRecord | null>;

  /** Open runs whose `deadlineAt` is at or before `now`, oldest deadline first. */
  overdue(now: number, limit: number): Promise<RunRecord[]>;

  /**
   * The store's clock, in epoch milliseconds, which `deadlineAt` is on.
   * Optional: a store without one is compared against `Date.now()`.
   */
  now?(): Promise<number>;

  /** Deletes runs that ended more than `olderThanMs` ago, and resolves to how many. */
  prune?(olderThanMs: number): Promise<number>;
}

/**
 * Runs in a map, for as long as the process lives.
 *
 * NOT DURABLE: a restart loses every run. It is the default so that runs
 * work in development and tests without a table; use `DatabaseRunStore` in
 * production. It only works when the work runs in this same process (the
 * memory queue driver), since a worker in another process has a map of its
 * own.
 */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private clock = 0;

  /** How many runs it holds. */
  get size(): number {
    return this.runs.size;
  }

  async create(run: NewRunRecord): Promise<RunRecord> {
    if (this.runs.has(run.id)) throw new Error(`A run with the id ${run.id} already exists.`);
    const now = this.tick();
    const record: RunRecord = {
      id: run.id,
      kind: run.kind,
      subject: run.subject,
      owner: run.owner,
      status: run.status,
      meta: structuredClone(run.meta ?? null),
      progress: null,
      result: null,
      error: null,
      version: 1,
      createdAt: now,
      startedAt: run.status === "running" ? now : null,
      updatedAt: now,
      finishedAt: null,
      deadlineAt: run.deadlineMs === null ? null : now + run.deadlineMs,
    };
    this.runs.set(record.id, record);
    return structuredClone(record);
  }

  async get(id: string): Promise<RunRecord | null> {
    const record = this.runs.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(filter: RunFilter): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const record of this.runs.values()) {
      if (filter.kind !== undefined && record.kind !== filter.kind) continue;
      if (filter.subject !== undefined && record.subject !== filter.subject) continue;
      if (filter.owner !== undefined && record.owner !== filter.owner) continue;
      if (filter.statuses && !filter.statuses.includes(record.status)) continue;
      out.push(record);
    }
    // Insertion order breaks ties between runs created in the same millisecond.
    out.reverse().sort((a, b) => b.createdAt - a.createdAt);
    return out.slice(0, listLimit(filter.limit)).map((record) => structuredClone(record));
  }

  async transition(
    id: string,
    from: readonly RunStatus[],
    to: RunUpdate,
  ): Promise<RunRecord | null> {
    const record = this.runs.get(id);
    if (!record || !from.includes(record.status)) return null;
    // Cloned before anything is assigned, so a value that is not plain data
    // fails the transition rather than half-applying it.
    const update = structuredClone(to);
    const now = this.tick();
    if (update.status !== undefined) {
      if (record.startedAt === null && update.status !== "pending") record.startedAt = now;
      if (isFinalRunStatus(update.status)) record.finishedAt = now;
      record.status = update.status;
    }
    if ("progress" in update) record.progress = update.progress ?? null;
    if ("result" in update) record.result = update.result ?? null;
    if ("error" in update) record.error = update.error ?? null;
    record.version += 1;
    record.updatedAt = now;
    return structuredClone(record);
  }

  async overdue(now: number, limit: number): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const record of this.runs.values()) {
      if (
        OPEN_RUN_STATUSES.includes(record.status) &&
        record.deadlineAt !== null &&
        record.deadlineAt <= now
      ) {
        out.push(record);
      }
    }
    out.sort((a, b) => a.deadlineAt! - b.deadlineAt!);
    return out.slice(0, Math.max(0, limit)).map((record) => structuredClone(record));
  }

  async now(): Promise<number> {
    return this.tick();
  }

  async prune(olderThanMs: number): Promise<number> {
    const before = this.tick() - olderThanMs;
    let count = 0;
    for (const [id, record] of this.runs) {
      if (record.finishedAt !== null && record.finishedAt <= before) {
        this.runs.delete(id);
        count++;
      }
    }
    return count;
  }

  /** `Date.now()`, never behind the last time it answered. */
  private tick(): number {
    this.clock = Math.max(this.clock, Date.now());
    return this.clock;
  }
}

/** `filter.limit`, bounded: 50 when absent, never negative. */
export function listLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  return Math.max(0, Math.floor(limit));
}
