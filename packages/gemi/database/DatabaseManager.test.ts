import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DatabaseManager } from "./DatabaseManager";

/**
 * `pragma foreign_keys` on a SQLite connection (#89).
 *
 * SQLite defaults it **off** and so does Bun's driver, which reports `0` on a
 * fresh connection. With it off SQLite enforces nothing: an insert naming a
 * parent that does not exist is accepted, a dangling reference survives the
 * parent's delete, and `ON DELETE RESTRICT` does not restrict — while the
 * migrations declare all three and Postgres enforces them always.
 *
 * These run against a real file rather than `:memory:`, because a foreign key
 * needs two tables that outlive one statement, and because the file case is the
 * one an application actually has.
 */
describe("sqlite foreign keys", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const path of workspaces.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  /** The pragma's value, read off whichever connection served the statement. */
  async function enabled(db: DatabaseManager) {
    const rows = (await db.sql.unsafe(`pragma foreign_keys`)) as any;
    return rows[0].foreign_keys;
  }

  function manager() {
    const workspace = mkdtempSync(join(tmpdir(), "gemi-fk-"));
    workspaces.push(workspace);
    return new DatabaseManager({ url: `sqlite://${join(workspace, "t.db")}` });
  }

  async function schema(db: DatabaseManager) {
    await db.sql.unsafe(`create table parent (id integer primary key)`);
    await db.sql.unsafe(
      `create table child (
         id integer primary key,
         pid integer references parent(id) on delete cascade
       )`,
    );
    await db.sql.unsafe(`create table detachable (
       id integer primary key,
       pid integer references parent(id) on delete set null
     )`);
    await db.sql.unsafe(`insert into parent (id) values (1)`);
  }

  test("it is on", async () => {
    const db = manager();
    expect(await enabled(db)).toBe(1);
    await db.close();
  });

  /**
   * The constructor is synchronous and the pragma is a statement, so it cannot
   * be awaited before returning. What makes that safe is that SQLite queues
   * statements on one connection in the order they were issued — so a caller
   * that queries immediately is already behind it.
   *
   * Asserted rather than assumed: this is the half that breaks first if Bun
   * ever serves SQLite from a pool.
   */
  test("a query issued immediately after construction is already behind it", async () => {
    const db = manager();
    const [rows] = await Promise.all([
      db.sql.unsafe(`pragma foreign_keys`) as Promise<any>,
      db.ready,
    ]);
    expect(rows[0].foreign_keys).toBe(1);
    await db.close();
  });

  /** The other half: one connection, so every statement sees the same answer. */
  test("concurrent queries all see it", async () => {
    const db = manager();
    const results = await Promise.all(
      Array.from({ length: 32 }, () => db.sql.unsafe(`pragma foreign_keys`)),
    );
    expect(new Set(results.map((rows: any) => rows[0].foreign_keys))).toEqual(
      new Set([1]),
    );
    await db.close();
  });

  test("an insert naming a parent that does not exist is refused", async () => {
    const db = manager();
    await schema(db);

    await expect(
      db.sql.unsafe(`insert into child (pid) values (999)`),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    await db.close();
  });

  test("on delete cascade removes the children", async () => {
    const db = manager();
    await schema(db);
    await db.sql.unsafe(`insert into child (pid) values (1), (1)`);

    await db.sql.unsafe(`delete from parent where id = 1`);

    const remaining = (await db.sql.unsafe(
      `select count(*) as c from child`,
    )) as any;
    expect(remaining[0].c).toBe(0);
    await db.close();
  });

  test("on delete set null detaches them instead", async () => {
    const db = manager();
    await schema(db);
    await db.sql.unsafe(`insert into detachable (pid) values (1)`);

    await db.sql.unsafe(`delete from parent where id = 1`);

    const detached = (await db.sql.unsafe(`select pid from detachable`)) as any;
    expect(detached[0].pid).toBeNull();
    await db.close();
  });

  /**
   * The pragma is documented as a no-op *inside* a transaction, which is why it
   * is issued from the constructor rather than lazily on first use — a lazy
   * version would be correct until the first use happened to be a transaction.
   */
  test("it holds inside a transaction, and after one", async () => {
    const db = manager();
    await schema(db);

    await db.sql.begin(async (tx: any) => {
      expect((await tx.unsafe(`pragma foreign_keys`))[0].foreign_keys).toBe(1);
      await expect(
        tx.unsafe(`insert into child (pid) values (999)`),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    expect(await enabled(db)).toBe(1);
    await db.close();
  });
});
