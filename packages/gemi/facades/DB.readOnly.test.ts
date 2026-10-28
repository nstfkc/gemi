import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { Application } from "../foundation/Application";
import { sql, unsafeSql } from "../orm/sql";
import { DB } from "./DB";

/**
 * `DB.readOnly` (#1064): a read-only transaction with `SET LOCAL` timeouts
 * and role, always rolled back.
 *
 * Postgres when `TEST_POSTGRES_URL` is set (CI's `queue-databases` job runs
 * the `postgres` suites), and the refusals on SQLite always.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

function useDatabase(config: ConstructorParameters<typeof DatabaseManager>[0]) {
  let previous: Application | undefined;
  let database: DatabaseManager;
  beforeAll(() => {
    database = new DatabaseManager(config);
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
  });
  afterAll(async () => {
    await database.close();
    if (previous) Application.setInstance(previous);
  });
}

describe("DB.readOnly on sqlite", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemi-read-only-"));
  useDatabase({ url: `sqlite://${join(dir, "db.sqlite")}` });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("is refused: Postgres only", async () => {
    await expect(DB.readOnly(async () => 1)).rejects.toThrow(/Postgres only/);
  });
});

describe("DB.readOnly on the servers this run has no URL for", () => {
  test.skipIf(!!POSTGRES_URL)("postgres did NOT run: set TEST_POSTGRES_URL", () => {
    console.warn("DB.readOnly: postgres did NOT run: set TEST_POSTGRES_URL");
  });
});

describe.skipIf(!POSTGRES_URL)("DB.readOnly on postgres", () => {
  const table = `gemi_read_only_${process.pid}`;
  // One connection per pool, so "does it leak" asks the connection that ran it.
  useDatabase({
    url: POSTGRES_URL!,
    options: { max: 1 },
    connections: { analytics: { url: POSTGRES_URL!, options: { max: 1 } } },
  });

  beforeAll(async () => {
    await DB.sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await DB.sql.unsafe(`CREATE TABLE ${table} (id int primary key, name text)`);
    await DB.sql.unsafe(`INSERT INTO ${table} VALUES (1, 'a'), (2, 'b')`);
    await DB.sql.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gemi_read_only_role') THEN
        CREATE ROLE gemi_read_only_role NOLOGIN;
      END IF;
    END $$`);
    await DB.sql.unsafe(`GRANT SELECT ON ${table} TO gemi_read_only_role`);
  });
  afterAll(async () => {
    await DB.sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  });

  test("returns the callback's result, and reads join the transaction", async () => {
    const rows = await DB.readOnly(async () => {
      const [mode] = await DB.query<{ mode: string }>(
        sql`select current_setting('transaction_read_only') as mode`,
      );
      const names = await DB.query<{ name: string }>(
        sql`select name from ${unsafeSql(table)} order by id`,
      );
      return { mode: mode!.mode, names: names.map((row) => row.name) };
    });
    expect(rows).toEqual({ mode: "on", names: ["a", "b"] });
  });

  test("a write inside fails, and nothing is written", async () => {
    await expect(
      DB.readOnly(() => DB.execute(sql`update ${unsafeSql(table)} set name = 'x'`)),
    ).rejects.toThrow(/read-only transaction/);
    const [row] = await DB.query<{ name: string }>(
      sql`select name from ${unsafeSql(table)} where id = 1`,
    );
    expect(row!.name).toBe("a");
  });

  test("the timeouts and the role apply inside, and do not leak to the connection", async () => {
    const before = await DB.query<Record<string, string>>(
      sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_user as who`,
    );
    const inside = await DB.connection("analytics").readOnly(
      {
        statementTimeoutMs: 8_000,
        lockTimeoutMs: 1_000,
        idleInTransactionTimeoutMs: 10_000,
        role: "gemi_read_only_role",
      },
      () =>
        DB.connection("analytics").query<Record<string, string>>(
          sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle, current_user as who`,
        ),
    );
    expect(inside[0]).toEqual({ statement: "8s", lock: "1s", idle: "10s", who: "gemi_read_only_role" });

    const after = await DB.connection("analytics").query<Record<string, string>>(
      sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_user as who`,
    );
    expect(after[0]).toEqual(before[0]);
  });

  test("the statement timeout cancels a slow statement", async () => {
    await expect(
      DB.readOnly({ statementTimeoutMs: 50 }, () => DB.query(sql`select pg_sleep(1)`)),
    ).rejects.toThrow(/statement timeout/);
  });

  test("the role's grants apply", async () => {
    await expect(
      DB.readOnly({ role: "gemi_read_only_role" }, () =>
        DB.query(sql`select * from pg_authid`),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test("the callback's error is passed through", async () => {
    await expect(
      DB.readOnly(async () => {
        throw new Error("from the callback");
      }),
    ).rejects.toThrow("from the callback");
  });

  test("is refused inside a transaction", async () => {
    await expect(
      DB.transaction(() => DB.readOnly(async () => 1)),
    ).rejects.toThrow(/cannot run inside a transaction/);
  });

  test("bad options are refused before anything runs", async () => {
    await expect(DB.readOnly({ role: 'x"; drop table t; --' }, async () => 1)).rejects.toThrow(
      /not a plain identifier/,
    );
    await expect(DB.readOnly({ statementTimeoutMs: 0 }, async () => 1)).rejects.toThrow(
      /positive whole number/,
    );
    await expect(DB.readOnly({ lockTimeoutMs: 1.5 }, async () => 1)).rejects.toThrow(
      /positive whole number/,
    );
    await expect((DB.readOnly as any)({})).rejects.toThrow(/needs a callback/);
  });
});
