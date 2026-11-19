import type { SQL } from "bun";

import type { Dialect } from "../../database/dialect";
import type { EnqueueJob } from "./QueueDriver";
import type { SlotRequest } from "./slots";
import { WORKFLOW_TICK_JOB } from "./workflow/WorkflowStore";

/**
 * Concurrency slots (#1319) in a table of the queue's database, so every
 * process sharing it shares one line per key. The model is in `slots.ts`.
 *
 * ### The table
 *
 * One row per key and holder, keyed by both. The empty holder is the key's
 * **gate** row: every step on a line starts by upserting it, which locks it
 * (a row lock on Postgres and MySQL, the file's write lock on SQLite), so the
 * steps on one key run one at a time across processes, and it keeps the
 * limit the line was last admitted under, for a release that has none. A
 * step on several keys locks their gates in sorted order first, so two steps
 * never wait on each other in a cycle.
 *
 * ### Indexed, all of it
 *
 * Every statement is on `(slot_key, state, queued_at, holder)`, on `(holder)`,
 * or a primary-key lookup, and the counts are `LIMIT`ed to the limit: an
 * admission costs the same with ten waiters or ten thousand, and nothing
 * counts or scans the jobs table. `DatabaseSlots.test.ts` runs `EXPLAIN` on
 * each statement on all three databases.
 *
 * On MySQL a step runs at READ COMMITTED on a connection of its own, as the
 * claim does: at REPEATABLE READ the range deletes and counts would take gap
 * locks reaching into the next key's rows, and steps on different keys would
 * wait on each other.
 */
export class DatabaseSlots {
  private readonly statements: SlotStatements;

  constructor(
    private readonly db: {
      sql: SQL;
      dialect: Dialect;
      configure(): Promise<void>;
      atomically<T>(fn: (q: SQL) => Promise<T>): Promise<T>;
      insertJob(q: SQL, job: EnqueueJob): Promise<string>;
    },
    tables: SlotTables,
  ) {
    this.statements = slotStatements(db.dialect, tables);
  }

  async acquire(request: SlotRequest): Promise<boolean> {
    return this.step(async (run) => {
      const keys = [...new Set(request.slots.map((slot) => slot.key))].sort();
      for (const key of keys) {
        const { limit } = request.slots.find((slot) => slot.key === key)!;
        await run("lockGate", { key, limit });
      }

      // A holder's place is when it first asked for any of its keys.
      const [known] = await run("placeOf", { holder: request.holder });
      const queued =
        known?.queued_at == null
          ? Number((await run("clock", {}))[0]!.now)
          : Number(known.queued_at);

      for (const { key, limit } of request.slots) {
        await this.prune(run, key);
        const [own] = await run("ticket", { key, holder: request.holder });
        if (!own) {
          await run("insertWaiting", {
            key,
            holder: request.holder,
            job: request.job.id,
            workflow: request.workflowId ?? null,
            queued,
          });
        } else if (String(own.job_id) !== request.job.id) {
          await run("pointAt", { key, holder: request.holder, job: request.job.id });
        }
        const place = own ? Number(own.queued_at) : queued;

        const grantable = async () =>
          (await this.count(run, "countHolders", { key })) +
            (await this.count(run, "countAhead", {
              key,
              queued: place,
              holder: request.holder,
              cap: Math.max(1, limit),
            })) <
          limit;
        let holding = own?.state === "holding";
        if (!holding && (await grantable())) holding = true;
        if (!holding) {
          // Waking drops the dead waiters ahead, which may leave room.
          await this.wake(run, key, limit, request.holder);
          holding = await grantable();
        }
        if (holding && own?.state !== "holding") await run("hold", { key, holder: request.holder });
        // A raised limit, or holders that were gone, can leave room behind this one too.
        if (holding) {
          await this.wake(run, key, limit, request.holder);
          continue;
        }

        const ahead = await this.count(run, "countAhead", {
          key,
          queued: place,
          holder: request.holder,
          cap: Math.max(1, limit),
        });
        // The first waiter re-checks soon even under a limit of 0, so a limit
        // raised while nothing else happens on the key is seen.
        const ms = ahead < Math.max(1, limit) ? request.recheckMs.near : request.recheckMs.far;
        await run("park", {
          id: request.job.id,
          attempt: request.job.attempt,
          ms: Math.max(0, Math.round(ms)),
        });
        return false;
      }
      return true;
    });
  }

  async release(holder: string): Promise<void> {
    await this.step(async (run) => {
      const rows = await run("keysOf", { holder });
      const keys = [...new Set(rows.map((row) => String(row.slot_key)))].sort();
      for (const key of keys) await run("touchGate", { key });
      for (const key of keys) {
        await run("deleteTicket", { key, holder });
        await this.prune(run, key);
        const [gate] = await run("gate", { key });
        await this.wake(run, key, Number(gate?.slot_limit ?? 0), holder);
      }
    });
  }

  /** Drops holders whose job or workflow is gone. */
  private async prune(run: Runner, key: string) {
    await run("pruneJobHolders", { key });
    // Only touched when a workflow holds a slot of this key, so a queue that
    // runs no workflows needs no workflow tables.
    if ((await run("hasWorkflowHolders", { key })).length > 0) {
      await run("pruneWorkflowHolders", { key });
    }
  }

  /** Makes the first waiters due, as many as `key` has free slots, dropping dead ones. */
  private async wake(run: Runner, key: string, limit: number, except: string) {
    let free = limit - (await this.count(run, "countHolders", { key }));
    while (free > 0) {
      const waiters = await run("nextWaiters", { key, except, n: free + 8 });
      if (waiters.length === 0) return;
      let dropped = 0;
      for (const waiter of waiters) {
        if (free <= 0) return;
        const holder = String(waiter.holder);
        const jobId = waiter.job_id == null ? null : String(waiter.job_id);
        const workflowId = waiter.workflow_id == null ? null : String(waiter.workflow_id);

        if (workflowId !== null) {
          const [workflow] = await run("workflowStatus", { id: workflowId });
          if (!workflow || INACTIVE.includes(String(workflow.status))) {
            await run("deleteTicket", { key, holder });
            dropped++;
            continue;
          }
        }
        if (jobId !== null) await run("wakeJob", { id: jobId });
        const [job] = jobId === null ? [] : await run("jobStatus", { id: jobId });
        const alive = job !== undefined && LIVE.includes(String(job.status));
        if (!alive) {
          if (workflowId === null) {
            await run("deleteTicket", { key, holder });
            dropped++;
            continue;
          }
          // A workflow whose parked tick is gone gets a new one.
          const tick = await this.db.insertJob(run.q, {
            name: WORKFLOW_TICK_JOB,
            args: JSON.stringify([workflowId]),
          });
          await run("pointAt", { key, holder, job: tick });
        }
        free--;
      }
      // Only dead waiters were dropped this round; with none dropped, every
      // waiter there is was woken.
      if (dropped === 0) return;
    }
  }

  private async count(run: Runner, name: CountStatement, params: Params): Promise<number> {
    const [row] = await run(name, params);
    return Number(row?.n ?? 0);
  }

  /**
   * One step on the lines, in a transaction of its own. On MySQL at READ
   * COMMITTED on a reserved connection (see the class), and every step is
   * retried a few times on a deadlock, which MySQL can still report for two
   * first upserts of one gate row.
   */
  private async step<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    await this.db.configure();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transaction((q) => fn(this.runner(q)));
      } catch (error) {
        if (attempt >= 4 || !isDeadlock(error))
          throw explainMissingTable(error, this.statements.table);
        await new Promise((resolve) =>
          setTimeout(resolve, 10 + Math.random() * 40 * (attempt + 1)),
        );
      }
    }
  }

  private async transaction<T>(fn: (q: SQL) => Promise<T>): Promise<T> {
    if (this.db.dialect !== "mysql" && this.db.dialect !== "mariadb") {
      return this.db.atomically(fn);
    }
    const connection = await this.db.sql.reserve();
    const [isolation] = (await connection`SELECT @@transaction_isolation AS level`) as Array<{
      level: string;
    }>;
    await connection`SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`;
    try {
      return (await connection.begin((tx) => fn(tx))) as T;
    } finally {
      const previous = isolation?.level?.replaceAll("-", " ");
      if (previous && /^[A-Z ]+$/.test(previous)) {
        await connection.unsafe(`SET SESSION TRANSACTION ISOLATION LEVEL ${previous}`);
      }
      connection.release();
    }
  }

  private runner(q: SQL): Runner {
    const run = (async (name: StatementName, params: Params) => {
      const [text, values] = this.statements.compile(name, params);
      return (await q.unsafe(text, values)) as Row[];
    }) as Runner;
    run.q = q;
    return run;
  }
}

type Row = Record<string, unknown>;
type Params = Record<string, string | number | null>;
type Runner = ((name: StatementName, params: Params) => Promise<Row[]>) & { q: SQL };
type CountStatement = "countHolders" | "countAhead";

/** A job whose slot is still held: waiting (parked, or due) or claimed. */
const LIVE = ["pending", "claimed"];
/** A workflow whose slot is no longer held. */
const INACTIVE = ["completed", "failed", "cancelled", "paused"];

export type SlotTables = { slots: string; jobs: string; workflows: string };

/**
 * The slots table, as Prisma generates it for the `GemiJobSlot` model in the
 * docs, with `IF NOT EXISTS` added.
 */
export function createSlotTableStatements(dialect: Dialect, table: string): string[] {
  if (dialect === "mysql" || dialect === "mariadb") {
    return [
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
    \`slot_key\` VARCHAR(191) NOT NULL,
    \`holder\` VARCHAR(191) NOT NULL,
    \`job_id\` VARCHAR(191) NULL,
    \`workflow_id\` VARCHAR(191) NULL,
    \`state\` VARCHAR(191) NOT NULL,
    \`slot_limit\` INTEGER NOT NULL DEFAULT 0,
    \`queued_at\` BIGINT NOT NULL,
    \`updated_at\` BIGINT NOT NULL,

    INDEX \`${table}_slot_key_state_queued_at_holder_idx\`(\`slot_key\`, \`state\`, \`queued_at\`, \`holder\`),
    INDEX \`${table}_holder_idx\`(\`holder\`),
    PRIMARY KEY (\`slot_key\`, \`holder\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    ];
  }
  const constraint = `,\n\n    CONSTRAINT "${table}_pkey" PRIMARY KEY ("slot_key", "holder")`;
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (
    "slot_key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "job_id" TEXT,
    "workflow_id" TEXT,
    "state" TEXT NOT NULL,
    "slot_limit" INTEGER NOT NULL DEFAULT 0,
    "queued_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL${constraint}
)`,
    `CREATE INDEX IF NOT EXISTS "${table}_slot_key_state_queued_at_holder_idx" ON "${table}"("slot_key", "state", "queued_at", "holder")`,
    `CREATE INDEX IF NOT EXISTS "${table}_holder_idx" ON "${table}"("holder")`,
  ];
}

export type StatementName =
  | "clock"
  | "lockGate"
  | "touchGate"
  | "gate"
  | "placeOf"
  | "ticket"
  | "insertWaiting"
  | "pointAt"
  | "hold"
  | "deleteTicket"
  | "keysOf"
  | "countHolders"
  | "countAhead"
  | "nextWaiters"
  | "pruneJobHolders"
  | "hasWorkflowHolders"
  | "pruneWorkflowHolders"
  | "wakeJob"
  | "jobStatus"
  | "workflowStatus"
  | "park";

export type SlotStatements = {
  table: string;
  /** The text of every statement, with `{name}` placeholders, for `EXPLAIN`. */
  texts: Record<StatementName, string>;
  /** A statement as the dialect's text and its positional values. */
  compile(name: StatementName, params: Params): [string, unknown[]];
};

/**
 * Every statement the slots run, per dialect, as text: one place to read
 * them, and what the test hands to `EXPLAIN`. Placeholders are `{name}`, and
 * `compile` turns them into `$n` (Postgres) or `?` (MySQL, SQLite).
 */
export function slotStatements(dialect: Dialect, tables: SlotTables): SlotStatements {
  const mysql = dialect === "mysql" || dialect === "mariadb";
  const quote = (name: string) => (mysql ? `\`${name}\`` : `"${name}"`);
  const S = quote(tables.slots);
  const J = quote(tables.jobs);
  const W = quote(tables.workflows);
  const now =
    dialect === "postgres"
      ? "floor(extract(epoch from statement_timestamp()) * 1000)::bigint"
      : mysql
        ? "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000)"
        : "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const int = (name: string) => (mysql ? `CAST({${name}} AS SIGNED)` : `CAST({${name}} AS BIGINT)`);
  const upsert = (set: string) =>
    mysql
      ? `ON DUPLICATE KEY UPDATE ${set.replace(/excluded\.(\w+)/g, "VALUES($1)")}`
      : `ON CONFLICT (slot_key, holder) DO UPDATE SET ${set}`;

  const texts: Record<StatementName, string> = {
    clock: `SELECT ${now} AS now`,
    lockGate: `INSERT INTO ${S} (slot_key, holder, state, slot_limit, queued_at, updated_at)
      VALUES ({key}, '', 'gate', ${int("limit")}, ${now}, ${now})
      ${upsert("slot_limit = excluded.slot_limit, updated_at = excluded.updated_at")}`,
    touchGate: `INSERT INTO ${S} (slot_key, holder, state, slot_limit, queued_at, updated_at)
      VALUES ({key}, '', 'gate', 0, ${now}, ${now})
      ${upsert("updated_at = excluded.updated_at")}`,
    gate: `SELECT slot_limit FROM ${S} WHERE slot_key = {key} AND holder = ''`,
    placeOf: `SELECT MIN(queued_at) AS queued_at FROM ${S} WHERE holder = {holder}`,
    ticket: `SELECT state, queued_at, job_id FROM ${S} WHERE slot_key = {key} AND holder = {holder}`,
    insertWaiting: `INSERT INTO ${S}
      (slot_key, holder, job_id, workflow_id, state, slot_limit, queued_at, updated_at)
      VALUES ({key}, {holder}, {job}, {workflow}, 'waiting', 0, ${int("queued")}, ${now})`,
    pointAt: `UPDATE ${S} SET job_id = {job}, updated_at = ${now}
      WHERE slot_key = {key} AND holder = {holder}`,
    hold: `UPDATE ${S} SET state = 'holding', updated_at = ${now}
      WHERE slot_key = {key} AND holder = {holder}`,
    deleteTicket: `DELETE FROM ${S} WHERE slot_key = {key} AND holder = {holder}`,
    keysOf: `SELECT slot_key FROM ${S} WHERE holder = {holder}`,
    countHolders: `SELECT COUNT(*) AS n FROM ${S} WHERE slot_key = {key} AND state = 'holding'`,
    countAhead: `SELECT COUNT(*) AS n FROM (
        SELECT holder FROM ${S}
        WHERE slot_key = {key} AND state = 'waiting'
          AND (queued_at < ${int("queued")} OR (queued_at = ${int("queued")} AND holder < {holder}))
        LIMIT {cap}
      ) ahead`,
    nextWaiters: `SELECT holder, job_id, workflow_id FROM ${S}
      WHERE slot_key = {key} AND state = 'waiting' AND holder <> {except}
      ORDER BY queued_at, holder
      LIMIT {n}`,
    pruneJobHolders: `DELETE FROM ${S}
      WHERE slot_key = {key} AND state = 'holding' AND workflow_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${J} WHERE ${J}.id = ${S}.holder AND ${J}.status IN ('pending', 'claimed')
        )`,
    hasWorkflowHolders: `SELECT holder FROM ${S}
      WHERE slot_key = {key} AND state = 'holding' AND workflow_id IS NOT NULL
      LIMIT 1`,
    pruneWorkflowHolders: `DELETE FROM ${S}
      WHERE slot_key = {key} AND state = 'holding' AND workflow_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${W}
          WHERE ${W}.id = ${S}.workflow_id
            AND ${W}.status NOT IN ('completed', 'failed', 'cancelled', 'paused')
        )`,
    wakeJob: `UPDATE ${J} SET available_at = ${now}, updated_at = ${now}
      WHERE id = {id} AND status = 'pending' AND available_at > ${now}`,
    jobStatus: `SELECT status FROM ${J} WHERE id = {id}`,
    workflowStatus: `SELECT status FROM ${W} WHERE id = {id}`,
    park: `UPDATE ${J}
      SET status = 'pending', attempts = attempts - 1, available_at = ${now} + ${int("ms")},
          lease_expires_at = NULL, updated_at = ${now}
      WHERE id = {id} AND status = 'claimed' AND attempts = ${int("attempt")}`,
  };

  const compiled = new Map<StatementName, { text: string; names: string[] }>();
  return {
    table: tables.slots,
    texts,
    compile(name, params) {
      let entry = compiled.get(name);
      if (!entry) {
        const names: string[] = [];
        const text = texts[name].replace(/\{([a-z]+)\}/g, (_, param: string) => {
          if (dialect === "postgres") {
            let index = names.indexOf(param);
            if (index === -1) index = names.push(param) - 1;
            return `$${index + 1}`;
          }
          names.push(param);
          return "?";
        });
        entry = { text, names };
        compiled.set(name, entry);
      }
      return [
        entry.text,
        entry.names.map((param) => {
          if (!(param in params)) throw new Error(`The slot statement ${name} needs {${param}}.`);
          return params[param];
        }),
      ];
    },
  };
}

function isDeadlock(error: unknown): boolean {
  const e = error as { errno?: unknown; code?: unknown; message?: unknown };
  return (
    e?.errno === 1213 ||
    e?.code === "40P01" ||
    /deadlock|try restarting transaction/i.test(String(e?.message ?? ""))
  );
}

function explainMissingTable(error: unknown, table: string): unknown {
  const message = String((error as Error)?.message ?? error);
  if (!/does not exist|doesn't exist|no such table/i.test(message) || !message.includes(table)) {
    return error;
  }
  return new Error(
    `Concurrency limits on the database driver need the "${table}" table, and the ` +
      `database says it is missing. Add the GemiJobSlot model from the docs ` +
      `(docs/jobs-and-queues.md#concurrency-limits--concurrency) and migrate, or call ` +
      `the driver's createTable().`,
    { cause: error },
  );
}
