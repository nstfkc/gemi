import type { SQL, TransactionSQL } from "bun";

import type { Dialect } from "../../../database/dialect";
import { commitDependsOn } from "../../../orm/context";
import type { EnqueueBatch, EnqueueJob } from "../QueueDriver";
import {
  type AcquireResult,
  type StepRecord,
  type StepRunStatus,
  WORKFLOW_TICK_JOB,
  type WorkflowChange,
  WorkflowLeaseLostError,
  sameTick,
  type WorkflowRecord,
  type WorkflowRunStatus,
  type WorkflowSnapshot,
  type WorkflowState,
  type WorkflowStore,
} from "./WorkflowStore";

/** A SQL fragment, as the driver's helpers build them. */
type Fragment = ReturnType<SQL["unsafe"]>;

/**
 * What the database queue driver lends its workflow store: its connection,
 * its transactions and clock, and the writes a workflow's changes schedule.
 * The driver builds it from its private methods, so the two share one
 * transaction per change.
 */
export type DatabaseQueueInternals = {
  sql: SQL;
  dialect: Dialect;
  connection: string | undefined;
  configure(): Promise<void>;
  atomically<T>(fn: (q: SQL) => Promise<T>): Promise<T>;
  transaction(): TransactionSQL | undefined;
  now(q: SQL): Fragment;
  ms(q: SQL, value: number): Fragment;
  timeOrNull(q: SQL, value: number | null): Fragment;
  fraction(q: SQL, value: number): Fragment;
  clock(q: SQL): Promise<number>;
  insertJob(q: SQL, job: EnqueueJob): Promise<string>;
  insertBatch(q: SQL, batch: EnqueueBatch): Promise<void>;
  cancelBatch(q: SQL, id: string): Promise<boolean>;
  quoted(identifier: string): string;
};

type Row = Record<string, unknown>;

const ENDED: WorkflowRunStatus[] = ["completed", "failed", "cancelled"];

/**
 * Workflows in two tables of the queue's database: one row per workflow, and
 * one per step, keyed by the workflow and the step's key.
 *
 * Every change runs in a transaction that locks the workflow's row first
 * (`SELECT … FOR UPDATE` on Postgres and MySQL; a no-op write on SQLite, which
 * takes the file's write lock), reads what the change depends on, and writes
 * it together with any tick job or batch it schedules. The queue's batch
 * transactions lock a batch row and then job rows and never a workflow row,
 * so the two kinds cannot deadlock on each other.
 */
export class DatabaseWorkflowStore implements WorkflowStore {
  readonly table: string;
  readonly stepTable: string;

  constructor(
    private readonly db: DatabaseQueueInternals,
    options: { table: string; stepTable: string },
  ) {
    this.table = options.table;
    this.stepTable = options.stepTable;
  }

  joinsTransaction(): boolean {
    return this.db.transaction() !== undefined;
  }

  create(workflow: { id: string; name: string; args: string }): Promise<void> {
    // On the caller's transaction when the driver would join it, as a
    // dispatch does; otherwise in a transaction of its own.
    const tx = this.db.transaction();
    const written = tx
      ? this.insertWorkflow(tx, workflow)
      : this.db.atomically((q) => this.insertWorkflow(q, workflow));
    if (tx) commitDependsOn(written);
    return written;
  }

  private async insertWorkflow(
    q: SQL,
    workflow: { id: string; name: string; args: string },
  ): Promise<void> {
    await this.db.configure();
    const now = this.db.now(q);
    await explainMissingSchema(
      q`
        INSERT INTO ${this.workflows(q)}
          (id, name, args, status, progress, retick, created_at, updated_at)
        VALUES
          (${workflow.id}, ${workflow.name}, ${workflow.args}, 'running',
           ${this.db.fraction(q, 0)}, 0, ${now}, ${now})
      `,
      this.table,
    );
    await this.db.insertJob(q, { name: WORKFLOW_TICK_JOB, args: JSON.stringify([workflow.id]) });
  }

  async find(id: string, options: { steps?: boolean } = {}): Promise<WorkflowState | null> {
    await this.db.configure();
    const q = this.db.sql;
    const [row] = (await explainMissingSchema(
      q`SELECT * FROM ${this.workflows(q)} WHERE id = ${id}`,
      this.table,
    )) as Row[];
    if (!row) return null;
    return {
      workflow: workflowRecord(row),
      steps: options.steps === false ? [] : await this.stepsOf(q, id),
    };
  }

  acquire(id: string, owner: string, leaseMs: number): Promise<AcquireResult> {
    return this.db.atomically(async (q) => {
      const workflow = await this.lock(q, id);
      if (!workflow) return { kind: "missing" } as const;
      const now = await this.db.clock(q);
      if (
        workflow.lockedBy !== null &&
        !sameTick(workflow.lockedBy, owner) &&
        (workflow.lockedUntil ?? 0) > now
      ) {
        await q`UPDATE ${this.workflows(q)} SET retick = 1 WHERE id = ${id}`;
        return { kind: "busy" } as const;
      }
      const until = now + Math.max(0, Math.round(leaseMs));
      await q`
        UPDATE ${this.workflows(q)}
        SET locked_by = ${owner}, locked_until = ${this.db.ms(q, until)}, retick = 0
        WHERE id = ${id}
      `;
      return {
        kind: "acquired",
        workflow: { ...workflow, lockedBy: owner, lockedUntil: until, retick: false },
        steps: await this.stepsOf(q, id),
      } as const;
    });
  }

  async renew(id: string, owner: string, leaseMs: number): Promise<boolean> {
    await this.db.configure();
    const q = this.db.sql;
    const result = await q`
      UPDATE ${this.workflows(q)}
      SET locked_until = ${this.db.now(q)} + ${this.db.ms(q, leaseMs)}
      WHERE id = ${id} AND locked_by = ${owner}
    `;
    return affected(result) > 0;
  }

  update<T>(
    id: string,
    options: { owner?: string; key?: string; allSteps?: boolean },
    decide: (snapshot: WorkflowSnapshot) => WorkflowChange<T>,
  ): Promise<T | undefined> {
    return this.db.atomically(async (q) => {
      const workflow = await this.lock(q, id);
      if (!workflow) return undefined;
      if (options.owner !== undefined && workflow.lockedBy !== options.owner) {
        throw new WorkflowLeaseLostError(id);
      }
      const step = options.key === undefined ? null : await this.stepOf(q, id, options.key);
      const steps = options.allSteps ? await this.stepsOf(q, id) : [];
      const change = decide({ workflow, step, steps, now: Date.now() });

      if (change.step) {
        const exists =
          change.step.key === options.key
            ? step !== null
            : (await this.stepOf(q, id, change.step.key)) !== null;
        await this.writeStep(q, change.step, exists);
      }
      if (change.batch) await this.db.insertBatch(q, change.batch);
      for (const batchId of change.cancelBatches ?? []) await this.db.cancelBatch(q, batchId);

      const next: WorkflowRecord = { ...workflow, ...change.workflow };
      const unlock = change.unlock === true;
      const set = q`
        status = ${next.status}, current_step = ${next.currentStep},
        progress = ${this.db.fraction(q, next.progress)}, result = ${next.result},
        error = ${next.error}, wake_at = ${this.db.timeOrNull(q, next.wakeAt)},
        updated_at = ${this.db.now(q)}
      `;
      if (unlock) {
        await q`
          UPDATE ${this.workflows(q)}
          SET ${set}, locked_by = NULL, locked_until = NULL, retick = 0
          WHERE id = ${id}
        `;
      } else {
        await q`UPDATE ${this.workflows(q)} SET ${set} WHERE id = ${id}`;
      }

      const tick = (delayMs: number) =>
        this.db.insertJob(q, {
          name: WORKFLOW_TICK_JOB,
          args: JSON.stringify([id]),
          delayMs: Math.max(0, Math.round(delayMs)),
        });
      if (change.tick) await tick(change.tick.delayMs);
      if (unlock && workflow.retick) await tick(0);
      return change.result;
    });
  }

  async prune(olderThanMs: number): Promise<number> {
    return this.db.atomically(async (q) => {
      const ended = q`status IN (${ENDED.map((s) => q`${s}`).reduce((a, b) => q`${a}, ${b}`)})`;
      const cutoff = q`${this.db.now(q)} - ${this.db.ms(q, olderThanMs)}`;
      await q`
        DELETE FROM ${this.steps(q)}
        WHERE workflow_id IN (
          SELECT id FROM ${this.workflows(q)} WHERE ${ended} AND updated_at <= ${cutoff}
        )
      `;
      const result = await q`
        DELETE FROM ${this.workflows(q)} WHERE ${ended} AND updated_at <= ${cutoff}
      `;
      return affected(result);
    });
  }

  private async writeStep(q: SQL, step: StepRecord, exists: boolean) {
    const db = this.db;
    const key = this.keyColumn(q);
    if (exists) {
      await q`
        UPDATE ${this.steps(q)}
        SET status = ${step.status}, attempt = ${step.attempt}, output = ${step.output},
            error = ${step.error}, batch_id = ${step.batchId},
            wake_at = ${db.timeOrNull(q, step.wakeAt)},
            started_at = ${db.timeOrNull(q, step.startedAt)},
            finished_at = ${db.timeOrNull(q, step.finishedAt)}, updated_at = ${db.now(q)}
        WHERE workflow_id = ${step.workflowId} AND ${key} = ${step.key}
      `;
      return;
    }
    const now = db.now(q);
    await q`
      INSERT INTO ${this.steps(q)}
        (workflow_id, ${key}, status, attempt, output, error, batch_id, wake_at,
         started_at, finished_at, created_at, updated_at)
      VALUES
        (${step.workflowId}, ${step.key}, ${step.status}, ${step.attempt}, ${step.output},
         ${step.error}, ${step.batchId}, ${db.timeOrNull(q, step.wakeAt)},
         ${db.timeOrNull(q, step.startedAt)}, ${db.timeOrNull(q, step.finishedAt)}, ${now}, ${now})
    `;
  }

  /**
   * Reads the workflow's row and holds it until the transaction ends, as the
   * driver's `lockBatch` holds a batch's.
   */
  private async lock(q: SQL, id: string): Promise<WorkflowRecord | undefined> {
    let rows: Row[];
    if (this.db.dialect === "sqlite") {
      await explainMissingSchema(
        q`UPDATE ${this.workflows(q)} SET updated_at = updated_at WHERE id = ${id}`,
        this.table,
      );
      rows = await q`SELECT * FROM ${this.workflows(q)} WHERE id = ${id}`;
    } else {
      rows = await explainMissingSchema(
        q`SELECT * FROM ${this.workflows(q)} WHERE id = ${id} FOR UPDATE`,
        this.table,
      );
    }
    return rows[0] ? workflowRecord(rows[0]) : undefined;
  }

  private async stepOf(q: SQL, id: string, key: string): Promise<StepRecord | null> {
    const [row] = (await explainMissingSchema(
      q`SELECT * FROM ${this.steps(q)} WHERE workflow_id = ${id} AND ${this.keyColumn(q)} = ${key}`,
      this.stepTable,
    )) as Row[];
    return row ? stepRecord(row) : null;
  }

  private async stepsOf(q: SQL, id: string): Promise<StepRecord[]> {
    const rows = (await explainMissingSchema(
      q`
        SELECT * FROM ${this.steps(q)} WHERE workflow_id = ${id}
        ORDER BY created_at, ${this.keyColumn(q)}
      `,
      this.stepTable,
    )) as Row[];
    return rows.map(stepRecord);
  }

  private workflows(q: SQL) {
    return q.unsafe(this.db.quoted(this.table));
  }

  private steps(q: SQL) {
    return q.unsafe(this.db.quoted(this.stepTable));
  }

  /** `key` is a reserved word in MySQL. */
  private keyColumn(q: SQL) {
    return q.unsafe(this.db.quoted("key"));
  }
}

function time(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

function workflowRecord(row: Row): WorkflowRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    args: String(row.args),
    status: String(row.status) as WorkflowRunStatus,
    currentStep: text(row.current_step),
    progress: Number(row.progress ?? 0),
    result: text(row.result),
    error: text(row.error),
    wakeAt: time(row.wake_at),
    lockedBy: text(row.locked_by),
    lockedUntil: time(row.locked_until),
    retick: Number(row.retick ?? 0) !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function stepRecord(row: Row): StepRecord {
  return {
    workflowId: String(row.workflow_id),
    key: String(row.key),
    status: String(row.status) as StepRunStatus,
    attempt: Number(row.attempt ?? 0),
    output: text(row.output),
    error: text(row.error),
    batchId: text(row.batch_id),
    wakeAt: time(row.wake_at),
    startedAt: time(row.started_at),
    finishedAt: time(row.finished_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function affected(result: unknown): number {
  const counts = result as { count?: number | null; affectedRows?: number | null };
  return Math.max(Number(counts.count ?? 0), Number(counts.affectedRows ?? 0));
}

function isMissingSchema(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /does not exist|doesn't exist|unknown column|no such (table|column)|has no column/i.test(
    message,
  );
}

/**
 * Runs a statement that needs the workflow tables, and turns "no such table"
 * into an error that says what to do about it.
 */
async function explainMissingSchema<T>(statement: PromiseLike<T>, table: string): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    throw new Error(
      `Workflows need the "${table}" table, and the database says it is missing. ` +
        `Add the GemiWorkflow and GemiWorkflowStep models from the docs ` +
        `(docs/workflows.md#the-workflow-tables) and migrate, or call the queue ` +
        `driver's createTable().`,
      { cause: error },
    );
  }
}

/**
 * The two workflow tables, as Prisma generates them for the `GemiWorkflow`
 * and `GemiWorkflowStep` models in the docs (checked against `prisma migrate
 * diff` for all three providers), with `IF NOT EXISTS` added. MySQL cannot
 * say that of an index, so its index is declared inside the table, which is
 * also where Prisma puts it.
 */
export function createWorkflowTableStatements(
  dialect: Dialect,
  table: string,
  stepTable: string,
): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`id\` VARCHAR(191) NOT NULL,
    \`name\` VARCHAR(191) NOT NULL,
    \`args\` LONGTEXT NOT NULL,
    \`status\` VARCHAR(191) NOT NULL,
    \`current_step\` VARCHAR(191) NULL,
    \`progress\` DOUBLE NOT NULL DEFAULT 0,
    \`result\` LONGTEXT NULL,
    \`error\` LONGTEXT NULL,
    \`wake_at\` BIGINT NULL,
    \`locked_by\` VARCHAR(191) NULL,
    \`locked_until\` BIGINT NULL,
    \`retick\` INTEGER NOT NULL DEFAULT 0,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    INDEX \`${table}_status_idx\`(\`status\`),
    PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS \`${stepTable}\` (
    \`workflow_id\` VARCHAR(191) NOT NULL,
    \`key\` VARCHAR(191) NOT NULL,
    \`status\` VARCHAR(191) NOT NULL,
    \`attempt\` INTEGER NOT NULL DEFAULT 0,
    \`output\` LONGTEXT NULL,
    \`error\` LONGTEXT NULL,
    \`batch_id\` VARCHAR(191) NULL,
    \`wake_at\` BIGINT NULL,
    \`started_at\` BIGINT NULL,
    \`finished_at\` BIGINT NULL,
    \`created_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    PRIMARY KEY (\`workflow_id\`, \`key\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }

  const sqlite = dialect === "sqlite";
  const progress = sqlite ? "REAL" : "DOUBLE PRECISION";
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    "id" TEXT NOT NULL${sqlite ? " PRIMARY KEY" : ""},
    "name" TEXT NOT NULL,
    "args" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "current_step" TEXT,
    "progress" ${progress} NOT NULL DEFAULT 0,
    "result" TEXT,
    "error" TEXT,
    "wake_at" BIGINT,
    "locked_by" TEXT,
    "locked_until" BIGINT,
    "retick" INTEGER NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${sqlite ? "" : `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")`}
)`,
    `CREATE TABLE IF NOT EXISTS "${stepTable}" (
    "workflow_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "output" TEXT,
    "error" TEXT,
    "batch_id" TEXT,
    "wake_at" BIGINT,
    "started_at" BIGINT,
    "finished_at" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    ${
      sqlite
        ? `PRIMARY KEY ("workflow_id", "key")`
        : `CONSTRAINT "${stepTable}_pkey" PRIMARY KEY ("workflow_id","key")`
    }
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_status_idx" ON "${table}"("status")`,
  ];
}
