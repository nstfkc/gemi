import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { DatabaseLockStore } from "../services/lock/DatabaseLockStore";
import {
  afterCommit,
  currentTransaction,
  ormContext,
  queuedOnSqlite,
  TransactionQueueDeadlockError,
  withTransaction,
} from "./context";
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

  test("a store's transactions take turns with the ORM's on the same connection", async () => {
    const connection = database.connection();
    // Both the store's own `begin` (no connection name) and its ORM-joined form.
    const raw = new DatabaseLockStore({ sql: connection.sql, dialect: connection.dialect }, { table: `${table}_locks` });
    const named = new DatabaseLockStore(connection, { table: `${table}_locks` });
    await raw.createTable();
    for (const store of [raw, named]) {
      const token = (await store.acquire("job", "me", 60_000))!;
      expect(token).not.toBeNull();
      const held = gate();
      const fenced = store.fence("job", "me", token, async () => {
        await held.opened;
        return "fenced";
      });
      await tick();
      const orm = Note.transaction(async () => {
        await Note.create({ data: { body: "beside the store" } });
      });
      await tick();
      held.open();
      expect(await within(fenced)).toBe("fenced");
      await within(orm);
      await store.release("job", "me", token);
    }
    expect(await bodies()).toEqual(["beside the store", "beside the store"]);
  });

  test("a raw begin through queuedOnSqlite takes its turn with the ORM's", async () => {
    const pool = database.connection().sql;
    const held = gate();
    const orm = Note.transaction(async () => {
      await Note.create({ data: { body: "orm" } });
      await held.opened;
    });
    await tick();
    const raw = queuedOnSqlite(pool, () =>
      pool.begin(async (tx) => {
        await tx.unsafe(`INSERT INTO "${table}" (body) VALUES ('raw')`);
      }),
    );
    held.open();
    await within(Promise.all([orm, raw]));
    expect(await bodies()).toEqual(["orm", "raw"]);
  });

  test("two SQLite files don't wait on each other", async () => {
    const other = new DatabaseManager({ url: `sqlite://${join(dir, "other.sqlite")}` });
    try {
      const held = gate();
      const a = Note.transaction(async () => {
        await held.opened;
      });
      await tick();
      // On the other file's pool: no queue in common with `a`.
      await within(
        withTransaction(other.connection().sql, async (tx) => tx.unsafe("select 1"), { dialect: "sqlite" }),
        500,
      );
      held.open();
      await within(a);
    } finally {
      await other.close();
    }
  });

  /**
   * Runs `body` with fake timers, waits for `pending` to reach the queue,
   * then moves the clock past the 5s the queue gives a suspected deadlock.
   */
  async function after5s<T>(pending: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const settled = pending().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(5_000);
      return await settled;
    } finally {
      vi.useRealTimers();
    }
  }

  test("a store's own begin inside an open ORM transaction on its connection fails loudly after 5s, not hangs", async () => {
    const connection = database.connection();
    const raw = new DatabaseLockStore({ sql: connection.sql, dialect: connection.dialect }, { table: `${table}_locks` });
    await raw.createTable();
    const token = (await raw.acquire("inside", "me", 60_000))!;
    const outcome = await after5s(() =>
      Note.transaction(async () => {
        await raw.fence("inside", "me", token, async () => "never");
      }),
    );
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(TransactionQueueDeadlockError);
    await raw.release("inside", "me", token);
    // The queue goes on.
    await within(Note.transaction(async () => void (await Note.create({ data: { body: "after" } }))));
    expect(await bodies()).toEqual(["after"]);
  });

  test("a transaction from a scope that left its caller's transaction fails loudly after 5s, not hangs", async () => {
    // What an in-process API call or channel message does: leave the ORM scope
    // on purpose while the caller's transaction awaits it.
    const outcome = await after5s(() =>
      Note.transaction(async () => {
        await ormContext.exit(() =>
          Note.transaction(async () => {
            await Note.create({ data: { body: "inner" } });
          }),
        );
      }),
    );
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(TransactionQueueDeadlockError);
    expect(await bodies()).toEqual([]);
    await within(Note.transaction(async () => void (await Note.create({ data: { body: "after" } }))));
    expect(await bodies()).toEqual(["after"]);
  });

  test("work a transaction starts and doesn't wait for just waits its turn", async () => {
    // Inherits the transaction's async context, but the transaction never
    // awaits it: not a deadlock (a store's fire-and-forget write, say). An
    // ORM transaction there would join the open one as a savepoint; a
    // store's own `begin` queues.
    const pool = database.connection().sql;
    let detached!: Promise<unknown>;
    await within(
      Note.transaction(async () => {
        await Note.create({ data: { body: "outer" } });
        setTimeout(() => {
          detached = queuedOnSqlite(pool, () =>
            pool.begin(async (tx) => {
              await tx.unsafe(`INSERT INTO "${table}" (body) VALUES ('detached')`);
            }),
          );
        }, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await Note.create({ data: { body: "outer again" } });
      }),
    );
    await within(detached);
    expect(await bodies()).toEqual(["outer", "outer again", "detached"]);
  });

  test("development warns about a transaction waiting in the queue for long", async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const held = gate();
      const a = Note.transaction(async () => {
        await held.opened;
      });
      await Promise.resolve();
      const b = Note.transaction(async () => {});
      vi.advanceTimersByTime(5_000);
      const waited = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("has waited"));
      expect(waited).toHaveLength(1);
      vi.useRealTimers();
      held.open();
      await within(Promise.all([a, b]));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      process.env.NODE_ENV = previousEnv;
    }
  });
});
