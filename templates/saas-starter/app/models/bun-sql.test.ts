import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DB } from "gemi/facades";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, register, sql, type ModelSchema } from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * What the ORM and `DB` rely on from Bun's SQL driver, pinned where Bun 1.4.4
 * changed it, so the answers are the same on Bun 1.3 and 1.4.
 *
 * Bun 1.4.4 reworked Bun.SQL: `affectedRows` is set (0 for a `SELECT`) where it
 * was null, whole numbers from 2^51 to 2^53 - 1 are sent as int8 rather than
 * float8, a `Date` bound to text is ISO 8601, an untyped `sql.array` is no
 * longer cast to `JSON[]`, and a cached statement is prepared again after
 * `ALTER TABLE`. gemi depends on none of the old answers — rowcounts come from
 * `count`, lists cross as array literals, `Date` and `bigint` are encoded per
 * column — and these are the cases that would notice if that stopped being
 * true.
 *
 * The model is declared here, with the metadata the generator emits for
 *
 *     model BunSqlRow {
 *       id     Int      @id @default(autoincrement())
 *       label  String
 *       amount BigInt
 *       at     DateTime
 *     }
 */

const field = (name: string, type: string) => ({
  name,
  column: name,
  type,
  nullable: false,
  isId: false,
  isUpdatedAt: false,
});

const schema: ModelSchema = {
  name: "BunSqlRow",
  table: "BunSqlRow",
  fields: {
    id: { ...field("id", "Int"), isId: true, default: { kind: "autoincrement" } },
    label: field("label", "String"),
    amount: field("amount", "BigInt"),
    at: field("at", "DateTime"),
  } as ModelSchema["fields"],
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

type Args = Record<string, unknown>;
class BunSqlRow extends Model {
  static $schema = schema;
  static findMany(args?: Args) { return this.$exec("findMany", args) as Promise<any[]>; }
  static create(args: Args) { return this.$exec("create", args) as Promise<any>; }
  static updateMany(args: Args) { return this.$exec("updateMany", args) as Promise<{ count: number }>; }
  static deleteMany(args: Args) { return this.$exec("deleteMany", args) as Promise<{ count: number }>; }
}

const DDL = {
  sqlite: `CREATE TABLE "BunSqlRow" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NOT NULL, "amount" BIGINT NOT NULL, "at" DATETIME NOT NULL)`,
  postgres: `CREATE TABLE "BunSqlRow" ("id" SERIAL PRIMARY KEY, "label" TEXT NOT NULL, "amount" BIGINT NOT NULL, "at" TIMESTAMP(3) NOT NULL)`,
};

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    const createTable = async () => {
      await raw.unsafe(`DROP TABLE IF EXISTS "BunSqlRow"`);
      await raw.unsafe(url ? DDL.postgres : DDL.sqlite);
    };

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-bun-sql-"));
        target = `sqlite://${join(workspace, "bun-sql.db")}`;
      }
      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      if (url) await raw.unsafe(`DROP TABLE IF EXISTS "BunSqlRow"`);
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      register("BunSqlRow", BunSqlRow);
      await createTable();
    });

    const at = new Date("2024-06-15T12:34:56.789Z");
    const create = (data: Args = {}) =>
      Model.asSystem(() => BunSqlRow.create({ data: { label: "a", amount: 1n, at, ...data } }));

    test("a BigInt column keeps every digit of a number between 2^52 and 2^53", async () => {
      // 2^52 + 1: Bun 1.4.3 and earlier sent this number as float8, which is
      // still exact here, and 1.4.4 sends it as int8. Read back as a bigint on
      // both. (Past 2^53 SQLite truncates on the way in; that limit is pinned
      // in writes.coercion.test.ts.)
      const small = await create({ amount: 2 ** 52 + 1 });
      const large = await create({ amount: 2n ** 53n - 1n });
      expect([small.amount, large.amount]).toEqual([2n ** 52n + 1n, 2n ** 53n - 1n]);

      const rows = await Model.asSystem(() => BunSqlRow.findMany({ orderBy: { id: "asc" } }));
      expect(rows.map((row) => row.amount)).toEqual([2n ** 52n + 1n, 2n ** 53n - 1n]);

      const matched = await Model.asSystem(() =>
        BunSqlRow.findMany({ where: { amount: { gt: 2 ** 52 + 1 } } }),
      );
      expect(matched.map((row) => row.id)).toEqual([large.id]);
    });

    test("a DateTime round-trips to the millisecond, and a raw Date parameter matches it", async () => {
      const created = await create();
      expect(created.at).toEqual(at);

      const read = await Model.asSystem(() => BunSqlRow.findMany({ where: { at } }));
      expect(read.map((row) => row.at)).toEqual([at]);

      // A raw statement binds the Date the way the ORM stored it, on both
      // dialects: epoch milliseconds on SQLite, a timestamp on Postgres.
      const rows = await DB.query<{ id: number }>(
        sql`select "id" from "BunSqlRow" where "at" = ${at}`,
      );
      expect(rows.map((row) => Number(row.id))).toEqual([created.id]);
    });

    test("write counts come from the statement, never from affectedRows", async () => {
      await create({ label: "a" });
      await create({ label: "a" });
      await create({ label: "b" });

      await Model.asSystem(async () => {
        expect(await BunSqlRow.updateMany({ where: { label: "a" }, data: { label: "c" } })).toEqual({ count: 2 });
        expect(await BunSqlRow.updateMany({ where: { label: "zzz" }, data: { label: "c" } })).toEqual({ count: 0 });
        expect(await BunSqlRow.deleteMany({ where: { label: "b" } })).toEqual({ count: 1 });
      });

      expect(await DB.execute(sql`update "BunSqlRow" set "label" = ${"d"} where "label" = ${"c"}`)).toBe(2);
      expect(await DB.execute(sql`delete from "BunSqlRow" where "label" = ${"zzz"}`)).toBe(0);
      expect(await DB.execute(sql`delete from "BunSqlRow" where "label" = ${"d"}`)).toBe(2);
    });

    test("model reads keep working after ALTER TABLE adds a column", async () => {
      // On Postgres, Bun 1.4.3 and earlier failed a cached statement whose
      // result shape changed ("cached plan must not change result type"). The
      // ORM names its columns, so the shape it reads does not change, and the
      // same statement keeps working on every version.
      const created = await create();
      const read = () => Model.asSystem(() => BunSqlRow.findMany({ where: { id: created.id } }));
      expect((await read()).map((row) => row.id)).toEqual([created.id]);

      await raw.unsafe(`ALTER TABLE "BunSqlRow" ADD COLUMN "extra" INTEGER`);
      const after = await read();
      expect(after.map((row) => row.id)).toEqual([created.id]);
      expect(after[0]).not.toHaveProperty("extra");
    });
  });
}

suite("bun sql driver contract (sqlite)");

if (POSTGRES_URL) {
  suite("bun sql driver contract (postgres)", POSTGRES_URL);
} else {
  describe("bun sql driver contract (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
