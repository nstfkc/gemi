import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { isMultiStatement, SqliteBusyError } from "../database/sqliteClient";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { DatabaseLockStore } from "../services/lock/DatabaseLockStore";
import { ormContext, TransactionQueueDeadlockError } from "./context";
import { Model } from "./Model";
import { clearRegistry, register } from "./registry";
import type { FieldSchema, ModelSchema } from "./schema";

/**
 * #1375 on a real SQLite file: a statement outside any transaction runs on a
 * connection of its own, so it neither joins nor sees another request's open
 * transaction. A write that meets that transaction's lock waits for it in JS,
 * without blocking the event loop, and lands after it.
 */

const table = `gemi_sq2_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const field = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});
class Note extends Model {
  static $schema: ModelSchema = {
    name: "Note",
    table,
    fields: {
      id: field("id", {
        type: "Int",
        isId: true,
        nullable: false,
        default: { kind: "autoincrement" } as never,
      }),
      body: field("body"),
    },
    primaryKey: ["id"],
    uniques: [],
    relations: {},
  };
  static create(args: object) {
    return this.$exec("create", args);
  }
  static findMany(args: object) {
    return this.$exec("findMany", args);
  }
}

const dir = mkdtempSync(join(tmpdir(), "gemi-sq2-"));
let database: DatabaseManager;
let previous: Application | undefined;

beforeAll(async () => {
  database = new DatabaseManager({ url: `sqlite://${join(dir, "db.sqlite")}` });
  previous = Application.getInstance();
  const application = new Application();
  application.instance(DatabaseManager, database as never);
  Application.setInstance(application);
  register("Note", Note);
  await database
    .connection()
    .sql.unsafe(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)`);
});
afterAll(async () => {
  clearRegistry();
  await database.close();
  if (previous) Application.setInstance(previous);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await database.connection().sql.unsafe(`DELETE FROM "${table}"`);
});

const sql = () => database.connection().sql;
const bodies = async () =>
  ((await sql()`SELECT body FROM ${sql()(table)} ORDER BY id`) as { body: string }[]).map(
    (row) => row.body,
  );
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(promise: Promise<T>, ms = 3000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlocked")), ms)),
  ]);

describe("statements outside a transaction on SQLite (#1375)", () => {
  test("the file is in WAL mode on both connections", async () => {
    const [mode] = (await sql().unsafe("pragma journal_mode")) as { journal_mode: string }[];
    expect(mode!.journal_mode).toBe("wal");
    await DB.transaction(async (tx) => {
      const [inside] = (await tx.unsafe("pragma journal_mode")) as { journal_mode: string }[];
      expect(inside!.journal_mode).toBe("wal");
      const [fk] = (await tx.unsafe("pragma foreign_keys")) as { foreign_keys: number }[];
      expect(fk!.foreign_keys).toBe(1);
    });
    const [fk] = (await sql().unsafe("pragma foreign_keys")) as { foreign_keys: number }[];
    expect(fk!.foreign_keys).toBe(1);
  });

  test("a plain write during an open transaction waits without blocking the event loop, and lands after the commit", async () => {
    const held = gate();
    const opened = gate();
    const order: string[] = [];
    const tx = Note.transaction(async () => {
      await Note.create({ data: { body: "tx" } });
      opened.open();
      await held.opened;
      order.push("commit");
    });
    await opened.opened;
    const write = sql()`INSERT INTO ${sql()(table)} (body) VALUES ('plain')`.then(() =>
      order.push("plain"),
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await tick(60);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(order).toEqual([]);
    held.open();
    await within(Promise.all([tx, write]));
    expect(order).toEqual(["commit", "plain"]);
    expect(await bodies()).toEqual(["tx", "plain"]);
  });

  test("a plain write during a transaction that rolls back survives the rollback", async () => {
    const locks = new DatabaseLockStore(
      { sql: sql(), dialect: "sqlite" },
      { table: `${table}_locks` },
    );
    await locks.createTable();
    const opened = gate();
    const held = gate();
    const tx = Note.transaction(async () => {
      await Note.create({ data: { body: "rolled back" } });
      opened.open();
      await held.opened;
      throw new Error("no");
    });
    await opened.opened;
    // A model write and a store write, each from outside the transaction.
    const model = ormContext.exit(() => Note.create({ data: { body: "model" } }));
    const hit = ormContext.exit(() => locks.hit("sign-up", 10, 60_000));
    await tick();
    held.open();
    await expect(tx).rejects.toThrow("no");
    await within(Promise.all([model, hit]));
    expect(await bodies()).toEqual(["model"]);
    // The rate-limit hit was not rolled back with the unrelated transaction.
    expect(await ormContext.exit(() => locks.hit("sign-up", 10, 60_000))).toMatchObject({
      count: 2,
    });
  });

  test("a plain read doesn't see an open transaction's uncommitted rows", async () => {
    await sql()`INSERT INTO ${sql()(table)} (body) VALUES ('before')`;
    const opened = gate();
    const held = gate();
    const tx = Note.transaction(async () => {
      await Note.create({ data: { body: "uncommitted" } });
      // Inside, the transaction reads its own write.
      expect(((await Note.findMany({})) as { body: string }[]).map((row) => row.body)).toEqual([
        "before",
        "uncommitted",
      ]);
      opened.open();
      await held.opened;
    });
    await opened.opened;
    const outside = await within(
      ormContext.exit(() => Note.findMany({})) as Promise<{ body: string }[]>,
      500,
    );
    expect(outside.map((row) => row.body)).toEqual(["before"]);
    expect(await within(bodies(), 500)).toEqual(["before"]);
    held.open();
    await tx;
    // Read-your-writes: the commit is visible on the other connection at once.
    expect(await bodies()).toEqual(["before", "uncommitted"]);
  });

  test("a plain write right before a transaction is visible inside it", async () => {
    await sql()`INSERT INTO ${sql()(table)} (body) VALUES ('plain first')`;
    const seen = await Note.transaction(
      async () => (await Note.findMany({})) as { body: string }[],
    );
    expect(seen.map((row) => row.body)).toEqual(["plain first"]);
  });

  test("many plain writes and transactions at once all land, and no SQLITE_BUSY surfaces", async () => {
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      if (i % 4 === 0) {
        work.push(
          Note.transaction(async () => {
            await Note.create({ data: { body: `tx${i}a` } });
            await tick(1);
            await Note.create({ data: { body: `tx${i}b` } });
          }),
        );
      } else if (i % 4 === 1) {
        work.push(sql().unsafe(`INSERT INTO "${table}" (body) VALUES ('unsafe${i}')`));
      } else if (i % 4 === 2) {
        work.push(ormContext.exit(() => Note.create({ data: { body: `model${i}` } })));
      } else {
        work.push(sql()`INSERT INTO ${sql()(table)} (body) VALUES (${`plain${i}`})`);
      }
    }
    await within(Promise.all(work), 10_000);
    const all = await bodies();
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
  });

  test("a query's modifiers survive a retry", async () => {
    const opened = gate();
    const held = gate();
    const tx = Note.transaction(async () => {
      await Note.create({ data: { body: "tx" } });
      opened.open();
      await held.opened;
    });
    await opened.opened;
    const write = sql()`INSERT INTO ${sql()(table)} (body) VALUES ('v') RETURNING body`.values();
    await tick();
    held.open();
    await tx;
    expect([...((await within(write as Promise<unknown>)) as unknown[])]).toEqual([["v"]]);
  });

  test("a plain write awaited from inside the transaction's own context fails instead of hanging, naming its call", async () => {
    const started = Date.now();
    const result = Note.transaction(async () => {
      await Note.create({ data: { body: "tx" } });
      // The pool, not the transaction's handle: it can't land until the
      // transaction commits, which waits for it.
      await sql()`INSERT INTO ${sql()(table)} (body) VALUES ('pool')`;
    });
    const error = (await within(result, 8000).catch(
      (caught: unknown) => caught,
    )) as TransactionQueueDeadlockError;
    expect(error).toBeInstanceOf(TransactionQueueDeadlockError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    // Where it was issued, not the queue's timer.
    expect(error.callSite).toBeInstanceOf(Error);
    expect(error.stack).toContain("sqliteSecondConnection.test.ts");
    expect(error.stack).not.toContain("sqliteQueue.ts");
    expect(error.message).toContain(`Statement: INSERT INTO ? (body) VALUES ('pool')`);
    expect(await bodies()).toEqual([]);
  }, 10_000);

  test("a gemi store that writes through the pool inside a transaction fails the same way", async () => {
    const locks = new DatabaseLockStore(
      { sql: sql(), dialect: "sqlite" },
      { table: `${table}_locks2` },
    );
    await locks.createTable();
    const result = DB.transaction(async () => {
      await locks.hit("sign-up", 10, 60_000);
    });
    const error = (await within(result, 8000).catch(
      (caught: unknown) => caught,
    )) as TransactionQueueDeadlockError;
    expect(error).toBeInstanceOf(TransactionQueueDeadlockError);
    expect(error.stack).toContain("DatabaseLockStore.ts");
    // Before the transaction it works.
    expect(await locks.hit("sign-up", 10, 60_000)).toMatchObject({ count: 1 });
  }, 10_000);

  test("a read with a semicolon in a literal, a comment or at its end runs at once inside a transaction", async () => {
    await within(
      Note.transaction(async () => {
        await Note.create({ data: { body: "tx" } });
        const rows = (await sql().unsafe("SELECT ';' || 'x' AS v; -- trailing; comment")) as {
          v: string;
        }[];
        expect(rows[0]!.v).toBe(";x");
      }),
      1000,
    );
  });

  describe("multi-statement strings", () => {
    test("they are told apart from one statement", () => {
      expect(isMultiStatement("select 1")).toBe(false);
      expect(isMultiStatement("select 1;")).toBe(false);
      expect(isMultiStatement("select 1; \n ")).toBe(false);
      expect(isMultiStatement("insert into a values (1); insert into a values (2)")).toBe(true);
      expect(isMultiStatement("select 1; select 2 -- two")).toBe(true);
      expect(isMultiStatement("SELECT ';' || 'x' AS v")).toBe(false);
      expect(isMultiStatement("select 'it''s; fine'")).toBe(false);
      expect(isMultiStatement('select "a;b", [c;d], `e;f` from t')).toBe(false);
      expect(isMultiStatement("select 1 -- a; b\n")).toBe(false);
      expect(isMultiStatement("select 1; /* done; */ -- end")).toBe(false);
      expect(isMultiStatement("/* ; */ select 1; 'x'")).toBe(true);
    });

    test("one waits its turn behind an open transaction instead of meeting its lock, and runs once", async () => {
      const opened = gate();
      const held = gate();
      const tx = Note.transaction(async () => {
        await Note.create({ data: { body: "tx" } });
        opened.open();
        await held.opened;
      });
      await opened.opened;
      const multi = sql().unsafe(
        `INSERT INTO "${table}" (body) VALUES ('m1'); INSERT INTO "${table}" (body) VALUES ('m2')`,
      );
      await tick();
      held.open();
      await within(Promise.all([tx, multi]));
      expect(await bodies()).toEqual(["tx", "m1", "m2"]);
    });

    test("one that meets another connection's lock fails with SqliteBusyError and isn't run again", async () => {
      const { SQL } = await import("bun");
      const other = new SQL(`sqlite://${join(dir, "db.sqlite")}`);
      try {
        await other.unsafe("begin immediate");
        const multi = sql().unsafe(
          `INSERT INTO "${table}" (body) VALUES ('m1'); INSERT INTO "${table}" (body) VALUES ('m2')`,
        );
        await expect(within(multi as Promise<unknown>)).rejects.toBeInstanceOf(SqliteBusyError);
        await other.unsafe("rollback");
        expect(await bodies()).toEqual([]);
      } finally {
        await other.close();
      }
    });
  });

  test("a single statement retries another connection's lock until it is released", async () => {
    const { SQL } = await import("bun");
    const other = new SQL(`sqlite://${join(dir, "db.sqlite")}`);
    try {
      await other.unsafe("begin immediate");
      await other.unsafe(`INSERT INTO "${table}" (body) VALUES ('other')`);
      const write = sql()`INSERT INTO ${sql()(table)} (body) VALUES ('plain')`;
      const settled = (write as Promise<unknown>).then(() => "done");
      await tick(30);
      await other.unsafe("commit");
      expect(await within(settled)).toBe("done");
      expect(await bodies()).toEqual(["other", "plain"]);
    } finally {
      await other.close();
    }
  });
});

describe("transactions against another process's lock", () => {
  test("a BEGIN that meets it is tried again once the lock is released, and the body runs once", async () => {
    const { SQL } = await import("bun");
    const other = new SQL(`sqlite://${join(dir, "db.sqlite")}`);
    try {
      await other.unsafe("begin immediate");
      let runs = 0;
      const tx = Note.transaction(async () => {
        runs++;
        await Note.create({ data: { body: "tx" } });
      });
      await tick(30);
      expect(runs).toBe(0);
      await other.unsafe("commit");
      await within(tx);
      expect(runs).toBe(1);
      expect(await bodies()).toEqual(["tx"]);
    } finally {
      await other.close();
    }
  });
});

describe("closing", () => {
  test("closing the client closes both connections", async () => {
    const own = new DatabaseManager({ url: `sqlite://${join(dir, "closing.sqlite")}` });
    const pool = own.connection().sql;
    await pool`CREATE TABLE t (v TEXT)`;
    await pool.begin(async (tx) => {
      await tx`INSERT INTO t (v) VALUES ('x')`;
    });
    await pool.close();
    await expect(pool`SELECT 1`).rejects.toThrow();
    await expect(
      pool.begin(async (tx) => {
        await tx`SELECT 1`;
      }),
    ).rejects.toThrow();
  });
});

describe(":memory: keeps one connection", () => {
  test("statements and transactions share it, as before", async () => {
    const memory = new DatabaseManager({ url: "sqlite://:memory:" });
    try {
      const pool = memory.connection().sql;
      await pool`CREATE TABLE t (v TEXT)`;
      await pool.begin(async (tx) => {
        await tx`INSERT INTO t (v) VALUES ('in tx')`;
      });
      await pool`INSERT INTO t (v) VALUES ('plain')`;
      const rows = (await pool`SELECT v FROM t ORDER BY rowid`) as { v: string }[];
      expect(rows.map((row) => row.v)).toEqual(["in tx", "plain"]);
      const [mode] = (await pool.unsafe("pragma journal_mode")) as { journal_mode: string }[];
      expect(mode!.journal_mode).toBe("memory");
    } finally {
      await memory.close();
    }
  });
});
