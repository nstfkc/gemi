import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { afterCommit, currentTransaction } from "./context";
import { Model } from "./Model";
import { clearRegistry, register } from "./registry";
import type { FieldSchema, ModelSchema } from "./schema";

/**
 * #1362 on a real SQLite file: Bun's client runs every statement on one
 * connection, so a second `BEGIN` while a transaction is open used to fail
 * with "cannot start a transaction within a transaction". Top-level
 * transactions now queue per pool; savepoints don't.
 */

const table = `gemi_txq_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const field = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  column: name,
  type: "String",
  nullable: true,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});
const schema: ModelSchema = {
  name: "Note",
  table,
  fields: {
    id: field("id", { type: "Int", isId: true, nullable: false, default: { kind: "autoincrement" } as never }),
    body: field("body"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};
class Note extends Model {
  static $schema = schema;
  static create(args: object) {
    return this.$exec("create", args);
  }
  static findMany(args: object) {
    return this.$exec("findMany", args);
  }
}

const dir = mkdtempSync(join(tmpdir(), "gemi-txq-"));
let database: DatabaseManager;
let previous: Application | undefined;

beforeAll(async () => {
  database = new DatabaseManager({ url: `sqlite://${join(dir, "db.sqlite")}` });
  previous = Application.getInstance();
  const application = new Application();
  application.instance(DatabaseManager, database as never);
  Application.setInstance(application);
  register("Note", Note);
  await database.connection().sql.unsafe(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)`);
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

const bodies = async () =>
  ((await database.connection().sql.unsafe(`SELECT body FROM "${table}" ORDER BY id`)) as { body: string }[]).map(
    (row) => row.body,
  );
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Rejects when `promise` hasn't settled in `ms`: a deadlock fails the test instead of hanging it. */
const within = <T>(promise: Promise<T>, ms = 2000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlocked")), ms))]);

describe("transactions on one SQLite connection (#1362)", () => {
  test("two at once both commit, one after the other", async () => {
    const held = gate();
    const order: string[] = [];
    const a = Note.transaction(async () => {
      await Note.create({ data: { body: "a1" } });
      order.push("a open");
      await held.opened;
      await Note.create({ data: { body: "a2" } });
      order.push("a done");
    });
    await tick();
    const b = Note.transaction(async () => {
      order.push("b open");
      await Note.create({ data: { body: "b" } });
    });
    await tick();
    // b waits for a rather than failing at BEGIN.
    expect(order).toEqual(["a open"]);
    held.open();
    await within(Promise.all([a, b]));
    expect(order).toEqual(["a open", "a done", "b open"]);
    expect(await bodies()).toEqual(["a1", "a2", "b"]);
  });

  test("DB.transaction and Model.transaction share the queue", async () => {
    const held = gate();
    const a = DB.transaction(async (tx) => {
      await tx.unsafe(`INSERT INTO "${table}" (body) VALUES ('db')`);
      await held.opened;
    });
    await tick();
    const b = Note.transaction(async () => {
      await Note.create({ data: { body: "model" } });
    });
    held.open();
    await within(Promise.all([a, b]));
    expect(await bodies()).toEqual(["db", "model"]);
  });

  test("a rollback lets the next one go, and keeps nothing of its own", async () => {
    const a = Note.transaction(async () => {
      await Note.create({ data: { body: "rolled back" } });
      throw new Error("no");
    });
    const b = Note.transaction(async () => {
      await Note.create({ data: { body: "kept" } });
    });
    await expect(a).rejects.toThrow("no");
    await within(b);
    expect(await bodies()).toEqual(["kept"]);
  });

  test("an after-commit callback that opens a transaction does not wait on its own", async () => {
    const seen: string[] = [];
    const a = Note.transaction(async () => {
      await Note.create({ data: { body: "a" } });
      afterCommit(async () => {
        // Runs after a's COMMIT, while a's `transaction` has not resolved:
        // the queue has already let go.
        await Note.transaction(async () => {
          await Note.create({ data: { body: "from callback" } });
        });
        seen.push("callback done");
      });
    });
    const c = Note.transaction(async () => {
      await Note.create({ data: { body: "c" } });
    });
    await within(Promise.all([a, c]));
    expect(seen).toEqual(["callback done"]);
    expect((await bodies()).sort()).toEqual(["a", "c", "from callback"]);
  });

  test("an after-commit callback deferred in a queued transaction still runs, once, after the commit", async () => {
    const runs: string[] = [];
    const held = gate();
    const a = Note.transaction(async () => {
      await held.opened;
    });
    const b = Note.transaction(async () => {
      await Note.create({ data: { body: "b" } });
      afterCommit(() => {
        runs.push(`after b: ${currentTransaction() === undefined ? "outside" : "inside"}`);
      });
    });
    held.open();
    await within(Promise.all([a, b]));
    expect(runs).toEqual(["after b: outside"]);
  });

  test("a nested transaction is a savepoint: it doesn't queue, and its rollback keeps the outer one", async () => {
    await within(
      Note.transaction(async () => {
        await Note.create({ data: { body: "outer" } });
        await Note.transaction(async () => {
          await Note.create({ data: { body: "inner kept" } });
        });
        await Note.transaction(async () => {
          await Note.create({ data: { body: "inner rolled back" } });
          throw new Error("inner");
        }).catch(() => {});
        await DB.transaction(async (tx) => {
          await tx.unsafe(`INSERT INTO "${table}" (body) VALUES ('db inner')`);
        });
      }),
    );
    expect(await bodies()).toEqual(["outer", "inner kept", "db inner"]);
  });

  test("a savepoint's after-commit callback runs once the outer one commits, not when it is dropped", async () => {
    const runs: string[] = [];
    await within(
      Note.transaction(async () => {
        await Note.transaction(async () => {
          afterCommit(() => void runs.push("kept savepoint"));
        });
        await Note.transaction(async () => {
          afterCommit(() => void runs.push("rolled-back savepoint"));
          throw new Error("inner");
        }).catch(() => {});
        expect(runs).toEqual([]);
      }),
    );
    expect(runs).toEqual(["kept savepoint"]);
  });

  test("many at once all commit", async () => {
    await within(
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          Note.transaction(async () => {
            await Note.create({ data: { body: `n${i}` } });
            await tick();
          }),
        ),
      ),
      5000,
    );
    expect(await bodies()).toHaveLength(20);
  });
});
