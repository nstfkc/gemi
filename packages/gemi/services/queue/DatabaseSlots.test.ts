import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { DatabaseQueueDriver } from "./DatabaseQueueDriver";
import { type StatementName, slotStatements } from "./DatabaseSlots";

/**
 * Every statement the concurrency slots run (#1319) is answered from an
 * index or a primary key, on each database: `EXPLAIN` must show no full scan
 * of the slots, jobs or workflows table. An admission then costs the same
 * however many jobs the table holds and however long a key's line is.
 *
 * On SQLite always; on Postgres and MySQL when `TEST_POSTGRES_URL` /
 * `TEST_MYSQL_URL` are set. Postgres runs with `enable_seqscan` off, so a
 * plan that falls back to a sequential scan does so only because no index
 * can answer the statement, which is what is being asked; on a table of a
 * few rows it would pick one anyway.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

const params: Record<string, string | number | null> = {
  key: "import",
  holder: "job-1",
  except: "job-1",
  job: "job-1",
  workflow: null,
  id: "job-1",
  limit: 2,
  queued: 1000,
  cap: 2,
  n: 10,
  ms: 1000,
  attempt: 1,
};

/** Statements with nothing to read: an insert without a select. */
const WRITES_ONLY: StatementName[] = ["clock", "lockGate", "touchGate", "insertWaiting"];

const targets: Array<{ name: string; dialect: Dialect; url: () => string; cleanup?: () => void }> =
  [];
{
  const dir = mkdtempSync(join(tmpdir(), "gemi-slots-explain-"));
  targets.push({
    name: "sqlite",
    dialect: "sqlite",
    url: () => `sqlite://${join(dir, "jobs.db")}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  });
}
if (POSTGRES_URL) targets.push({ name: "postgres", dialect: "postgres", url: () => POSTGRES_URL });
if (MYSQL_URL) targets.push({ name: "mysql", dialect: "mysql", url: () => MYSQL_URL });

describe.each(targets)("slot statements on $name", (target) => {
  test("every statement uses an index", { timeout: 60_000 }, async () => {
    const mysql = target.dialect === "mysql";
    const table =
      target.dialect === "sqlite"
        ? "gemi_jobs"
        : `GemiJobs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const names = new DatabaseQueueDriver(
      { sql: undefined as never, dialect: target.dialect },
      { table },
    );
    const tables = { slots: names.slotTable, jobs: names.table, workflows: names.workflowTable };
    const quote = (name: string) => (mysql ? `\`${name}\`` : `"${name}"`);
    const sql = new SQL(target.url());
    // One connection, so Postgres' `SET` holds for every `EXPLAIN`. SQLite
    // has a single connection already, and no `reserve`.
    const connection = target.dialect === "sqlite" ? sql : await sql.reserve();
    try {
      await new DatabaseQueueDriver(
        { sql: connection, dialect: target.dialect },
        { table },
      ).createTable();
      // A few rows, so no planner can answer from an empty table alone.
      for (let i = 0; i < 50; i++) {
        await connection.unsafe(
          `INSERT INTO ${quote(tables.jobs)} (id, name, payload, status, attempts, available_at, created_at, updated_at)
           VALUES ('job-${i}', 'Import', '[]', '${i % 2 ? "pending" : "claimed"}', 1, ${i}, ${i}, ${i})`,
        );
        await connection.unsafe(
          `INSERT INTO ${quote(tables.slots)} (slot_key, holder, job_id, workflow_id, state, slot_limit, queued_at, updated_at)
           VALUES ('${i % 5 === 0 ? "import" : `k${i}`}', 'job-${i}', 'job-${i}', NULL, '${i % 3 ? "waiting" : "holding"}', 0, ${i}, ${i})`,
        );
      }
      if (target.dialect === "postgres") {
        await connection.unsafe(`ANALYZE ${quote(tables.jobs)}`);
        await connection.unsafe(`ANALYZE ${quote(tables.slots)}`);
        await connection.unsafe(`SET enable_seqscan = off`);
      }
      if (mysql)
        await connection.unsafe(`ANALYZE TABLE ${quote(tables.jobs)}, ${quote(tables.slots)}`);

      const statements = slotStatements(target.dialect, tables);
      const scans: string[] = [];
      for (const name of Object.keys(statements.texts) as StatementName[]) {
        if (WRITES_ONLY.includes(name)) continue;
        const [text, values] = statements.compile(name, params);
        scans.push(
          ...(await fullScans(connection, target.dialect, text, values, tables)).map(
            (scan) => `${name}: ${scan}`,
          ),
        );
      }
      expect(scans).toEqual([]);
    } finally {
      if (target.dialect !== "sqlite") {
        for (const suffix of [
          "",
          "_batches",
          "_slots",
          "_workflows",
          "_workflow_steps",
          "_workflow_items",
          "_workflow_sources",
        ]) {
          await connection.unsafe(`DROP TABLE IF EXISTS ${quote(`${table}${suffix}`)}`);
        }
      }
      if (connection !== sql)
        (connection as ReturnType<SQL["reserve"]> extends Promise<infer R> ? R : never).release();
      await sql.close();
      target.cleanup?.();
    }
  });
});

/** The full scans of a real table in the statement's plan, described. */
async function fullScans(
  q: SQL,
  dialect: Dialect,
  text: string,
  values: unknown[],
  tables: { slots: string; jobs: string; workflows: string },
): Promise<string[]> {
  const real = new Set(Object.values(tables));
  if (dialect === "sqlite") {
    const rows = (await q.unsafe(`EXPLAIN QUERY PLAN ${text}`, values)) as Array<{
      detail: string;
    }>;
    return rows
      .map((row) => row.detail)
      .filter((detail) => {
        const scan = /^SCAN (\S+)/.exec(detail);
        return scan !== null && real.has(scan[1]!.replaceAll('"', "")) && !/USING/.test(detail);
      });
  }
  if (dialect === "postgres") {
    const [row] = (await q.unsafe(`EXPLAIN (FORMAT JSON) ${text}`, values)) as Array<{
      "QUERY PLAN": unknown;
    }>;
    const found: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node["Node Type"] === "Seq Scan" && real.has(String(node["Relation Name"]))) {
        found.push(`Seq Scan on ${String(node["Relation Name"])}`);
      }
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? [])
        walk(child);
    };
    const plan = (
      typeof row!["QUERY PLAN"] === "string"
        ? JSON.parse(row!["QUERY PLAN"] as string)
        : row!["QUERY PLAN"]
    ) as Array<{ Plan: Record<string, unknown> }>;
    walk(plan[0]!.Plan);
    return found;
  }
  const rows = (await q.unsafe(`EXPLAIN ${text}`, values)) as Array<{
    table: string | null;
    type: string | null;
  }>;
  return rows
    .filter((row) => row.table !== null && real.has(row.table) && row.type === "ALL")
    .map((row) => `type ALL on ${row.table}`);
}
