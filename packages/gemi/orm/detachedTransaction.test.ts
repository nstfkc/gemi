import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DatabaseManager } from "../database/DatabaseManager";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { currentTransaction, transactionDepth } from "./context";
import { Model } from "./Model";
import { clearRegistry, register } from "./registry";
import type { FieldSchema, ModelSchema } from "./schema";

/**
 * #1376: work a transaction starts and doesn't wait for (here a `setTimeout`)
 * inherits its scope. Once that transaction has settled, the work's own
 * `transaction()` is a transaction of its own, not a savepoint of the
 * finished one, and its writes land atomically on their own.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const table = `gemi_dtx_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
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

const dir = mkdtempSync(join(tmpdir(), "gemi-dtx-"));
const backends = [
  {
    name: "sqlite",
    url: () => `sqlite://${join(dir, "db.sqlite")}`,
    ddl: `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)`,
  },
  ...(POSTGRES_URL
    ? [{ name: "postgres", url: () => POSTGRES_URL, ddl: `CREATE TABLE "${table}" (id SERIAL PRIMARY KEY, body TEXT)` }]
    : []),
];

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `work` from a timer the transaction doesn't wait for, and hands back its outcome. */
function detached<T>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  return new Promise((resolve) => {
    setTimeout(() => {
      work().then(
        (value) => resolve({ status: "fulfilled", value }),
        (reason: unknown) => resolve({ status: "rejected", reason }),
      );
    }, 20);
  });
}

describe.each(backends)("a transaction started by detached work ($name)", ({ url, ddl }) => {
  let database: DatabaseManager;
  let previous: Application | undefined;

  beforeAll(async () => {
    database = new DatabaseManager({ url: url() });
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
    register("Note", Note);
    await database.connection().sql.unsafe(ddl);
  });
  afterAll(async () => {
    await database.connection().sql.unsafe(`DROP TABLE "${table}"`);
    clearRegistry();
    await database.close();
    if (previous) Application.setInstance(previous);
  });
  beforeEach(async () => {
    await database.connection().sql.unsafe(`DELETE FROM "${table}"`);
  });

  const bodies = async () =>
    ((await Note.findMany({ orderBy: { id: "asc" } })) as { body: string }[]).map((note) => note.body);

  test("after the outer one commits, it is a transaction of its own", async () => {
    let committed!: Promise<PromiseSettledResult<number | null>>;
    let failed!: Promise<PromiseSettledResult<void>>;
    let outer: unknown;
    await Note.transaction(async () => {
      outer = currentTransaction();
      await Note.create({ data: { body: "outer" } });
      committed = detached(() =>
        Note.transaction(async () => {
          expect(currentTransaction()).not.toBe(outer);
          await Note.create({ data: { body: "kept 1" } });
          await Note.create({ data: { body: "kept 2" } });
          return transactionDepth();
        }),
      );
      failed = detached(() =>
        DB.transaction(async () => {
          await Note.create({ data: { body: "dropped 1" } });
          await Note.create({ data: { body: "dropped 2" } });
          throw new Error("boom");
        }),
      );
    });

    expect(await committed).toEqual({ status: "fulfilled", value: 0 });
    expect(await failed).toMatchObject({ status: "rejected", reason: { message: "boom" } });
    expect(await bodies()).toEqual(["outer", "kept 1", "kept 2"]);
  });

  test("after the outer one rolls back, its writes stay", async () => {
    let committed!: Promise<PromiseSettledResult<void>>;
    let failed!: Promise<PromiseSettledResult<void>>;
    await expect(
      Note.transaction(async () => {
        await Note.create({ data: { body: "outer" } });
        committed = detached(() =>
          Note.transaction(async () => {
            await Note.create({ data: { body: "kept 1" } });
            await Note.create({ data: { body: "kept 2" } });
          }),
        );
        failed = detached(() =>
          Note.transaction(async () => {
            await Note.create({ data: { body: "dropped" } });
            throw new Error("boom");
          }),
        );
        throw new Error("outer rolls back");
      }),
    ).rejects.toThrow("outer rolls back");

    expect(await committed).toEqual({ status: "fulfilled", value: undefined });
    expect(await failed).toMatchObject({ status: "rejected" });
    expect(await bodies()).toEqual(["kept 1", "kept 2"]);
  });

  test("a plain statement after the outer one settled runs outside it", async () => {
    let wrote!: Promise<PromiseSettledResult<unknown>>;
    await Note.transaction(async () => {
      wrote = detached(async () => {
        expect(currentTransaction()).toBeUndefined();
        return Note.create({ data: { body: "later" } });
      });
    });
    expect(await wrote).toMatchObject({ status: "fulfilled" });
    expect(await bodies()).toEqual(["later"]);
  });

  test("while the outer one is still open, it stays a savepoint", async () => {
    await Note.transaction(async () => {
      const inner = await detached(() => Note.transaction(async () => transactionDepth()));
      expect(inner).toEqual({ status: "fulfilled", value: 1 });
    });
  });
});
