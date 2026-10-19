import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { s } from "gemi/ai";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  DbNull,
  InvalidArgumentError,
  JsonColumnError,
  Model,
  clearPlanCache,
  register,
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * Typed `Json` columns (#995) against a real database: `static $json` on a
 * model parses each column on every read path (find, select, include under
 * both strategies, the rows a write returns) and validates it on every write.
 *
 * The models are declared here, with the metadata the generator emits for
 *
 *     model JsonBook { id Int @id @default(autoincrement())  title String  pages JsonPage[] }
 *     model JsonPage {
 *       id Int @id @default(autoincrement())
 *       bookId Int
 *       book JsonBook @relation(fields: [bookId], references: [id])
 *       blocks Json
 *       style Json?
 *       legacy Json?
 *     }
 */

const bookSchema: ModelSchema = {
  name: "JsonBook",
  table: "JsonBook",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    title: { name: "title", column: "title", type: "String", nullable: false, isId: false, isUpdatedAt: false },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    pages: { name: "pages", model: "JsonPage", kind: "many", relationName: "JsonBookToJsonPage", from: [], to: [], nullable: false },
  },
};

const pageSchema: ModelSchema = {
  name: "JsonPage",
  table: "JsonPage",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    bookId: { name: "bookId", column: "bookId", type: "Int", nullable: false, isId: false, isUpdatedAt: false },
    blocks: { name: "blocks", column: "blocks", type: "Json", nullable: false, isId: false, isUpdatedAt: false },
    style: { name: "style", column: "style", type: "Json", nullable: true, isId: false, isUpdatedAt: false },
    legacy: { name: "legacy", column: "legacy", type: "Json", nullable: true, isId: false, isUpdatedAt: false },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    book: { name: "book", model: "JsonBook", kind: "one", relationName: "JsonBookToJsonPage", from: ["bookId"], to: ["id"], nullable: false },
  },
};

type Args = Record<string, unknown>;
type Options = Record<string, unknown> | undefined;
abstract class Ops extends Model {
  static findMany(args?: Args, options?: Options) { return this.$exec("findMany", args, options as never); }
  static findFirst(args?: Args, options?: Options) { return this.$exec("findFirst", args, options as never); }
  static findUnique(args: Args, options?: Options) { return this.$exec("findUnique", args, options as never); }
  static create(args: Args) { return this.$exec("create", args); }
  static createMany(args: Args) { return this.$exec("createMany", args); }
  static update(args: Args) { return this.$exec("update", args); }
  static updateMany(args: Args) { return this.$exec("updateMany", args); }
  static upsert(args: Args) { return this.$exec("upsert", args); }
}

const Block = s.object({ type: s.enum(["text", "image"]), body: s.string() });
const Style = s.object({ color: s.string() });

/** What the generator would emit. */
class JsonPageBase extends Ops {
  static $schema = pageSchema;
}

/** The app's model, with the column schemas. */
class JsonPage extends JsonPageBase {
  static $json = {
    blocks: s.array(Block),
    style: { schema: Style, invalid: "null" as const },
    legacy: { schema: Style, invalid: (value: unknown) => ({ color: `legacy:${JSON.stringify(value)}` }) },
  };
}

class JsonBook extends Ops {
  static $schema = bookSchema;
}

const DDL = {
  sqlite: [
    `CREATE TABLE "JsonBook" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL)`,
    `CREATE TABLE "JsonPage" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "bookId" INTEGER NOT NULL REFERENCES "JsonBook"("id"), "blocks" TEXT NOT NULL, "style" TEXT, "legacy" TEXT)`,
  ],
  postgres: [
    `DROP TABLE IF EXISTS "JsonPage"`,
    `DROP TABLE IF EXISTS "JsonBook"`,
    `CREATE TABLE "JsonBook" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL)`,
    `CREATE TABLE "JsonPage" ("id" SERIAL PRIMARY KEY, "bookId" INTEGER NOT NULL REFERENCES "JsonBook"("id"), "blocks" JSONB NOT NULL, "style" JSONB, "legacy" JSONB)`,
  ],
};

const STRATEGIES = ["batched", "lateral"] as const;
const TEXT = { type: "text", body: "hi" };

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let book: number;

    const json = (value: unknown) => (url ? `'${JSON.stringify(value)}'::jsonb` : `'${JSON.stringify(value)}'`);
    const storeRaw = (id: number, column: string, value: unknown) =>
      raw.unsafe(`UPDATE "JsonPage" SET "${column}" = ${json(value)} WHERE "id" = ${Number(id)}`);

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-json-columns-"));
        target = `sqlite://${join(workspace, "json.db")}`;
      }
      database = new DatabaseManager({ url: target });
      raw = new SQL(target);
      for (const statement of url ? DDL.postgres : DDL.sqlite) await raw.unsafe(statement);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      if (url) {
        await raw.unsafe(`DROP TABLE IF EXISTS "JsonPage"`);
        await raw.unsafe(`DROP TABLE IF EXISTS "JsonBook"`);
      }
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      register("JsonBook", JsonBook);
      register("JsonPage", JsonPage);
      await raw.unsafe(`DELETE FROM "JsonPage"`);
      await raw.unsafe(`DELETE FROM "JsonBook"`);
      book = ((await JsonBook.create({ data: { title: "t" } })) as { id: number }).id;
    });

    const createPage = (data: Record<string, unknown> = {}) =>
      JsonPage.create({ data: { bookId: book, blocks: [TEXT], ...data } }) as Promise<Record<string, any>>;

    describe("writes", () => {
      test("a valid value is written, with keys the schema does not know stripped", async () => {
        const created = await createPage({ blocks: [{ ...TEXT, extra: 1 }], style: { color: "red" } });
        expect(created.blocks).toEqual([TEXT]);
        const [row] = (await raw.unsafe(`SELECT "blocks" FROM "JsonPage" WHERE "id" = ${created.id}`)) as any[];
        const stored = typeof row.blocks === "string" ? JSON.parse(row.blocks) : row.blocks;
        expect(stored).toEqual([TEXT]);
      });

      test("an invalid value throws before the query, on every write", async () => {
        await expect(createPage({ blocks: [{ type: "video", body: "x" }] })).rejects.toThrow(InvalidArgumentError);
        await expect(createPage({ blocks: [{ type: "video", body: "x" }] })).rejects.toThrow("JsonPage.blocks does not match its schema");
        const { id } = await createPage();
        await expect(JsonPage.update({ where: { id }, data: { style: { color: 1 } } })).rejects.toThrow(InvalidArgumentError);
        await expect(JsonPage.updateMany({ where: {}, data: { blocks: "nope" } })).rejects.toThrow(InvalidArgumentError);
        await expect(JsonPage.createMany({ data: [{ bookId: book, blocks: [TEXT] }, { bookId: book, blocks: 1 }] })).rejects.toThrow(
          InvalidArgumentError,
        );
        await expect(
          JsonPage.upsert({ where: { id }, create: { bookId: book, blocks: [TEXT] }, update: { blocks: [1] } }),
        ).rejects.toThrow(InvalidArgumentError);
        expect(((await JsonPage.findMany({})) as any[]).length).toBe(1);
      });

      test("the null sentinels pass", async () => {
        const created = await createPage({ style: DbNull });
        expect(created.style).toBeNull();
      });

      test("a nested write into the model is validated by the model", async () => {
        await expect(
          JsonBook.create({ data: { title: "n", pages: { create: [{ blocks: [{ type: "nope" }] }] } } }),
        ).rejects.toThrow(InvalidArgumentError);
      });
    });

    describe("reads", () => {
      test("find and select answer the parsed value", async () => {
        const { id } = await createPage({ style: { color: "red" } });
        await storeRaw(id, "blocks", [{ ...TEXT, stale: true }]);
        expect(await JsonPage.findUnique({ where: { id } })).toMatchObject({ blocks: [TEXT], style: { color: "red" } });
        const selected = (await JsonPage.findFirst({ where: { id }, select: { blocks: true } })) as any;
        expect(selected).toEqual({ blocks: [TEXT] });
      });

      test('a value the schema refuses throws by default, answers null with invalid: "null", or the fallback', async () => {
        const { id } = await createPage();
        await storeRaw(id, "style", { color: 5 });
        await storeRaw(id, "legacy", "old");
        expect(await JsonPage.findUnique({ where: { id } })).toMatchObject({ style: null, legacy: { color: 'legacy:"old"' } });

        await storeRaw(id, "blocks", { not: "a list" });
        const error = await JsonPage.findUnique({ where: { id } }).catch((e) => e);
        expect(error).toBeInstanceOf(JsonColumnError);
        expect(error.column).toEqual({ model: "JsonPage", field: "blocks" });
        expect(error.value).toEqual({ not: "a list" });
      });

      test("SQL NULL in a nullable column stays null", async () => {
        const created = await createPage();
        expect(created).toMatchObject({ style: null, legacy: null });
      });

      for (const strategy of STRATEGIES) {
        test(`an include (${strategy})`, async () => {
          const { id } = await createPage();
          await storeRaw(id, "blocks", [{ ...TEXT, stale: true }]);
          const books = (await JsonBook.findMany({ include: { pages: true } }, { strategy })) as any[];
          expect(books[0].pages[0].blocks).toEqual([TEXT]);
        });
      }

      test("a read through the generated base parses the registered model's columns", async () => {
        const { id } = await createPage();
        await storeRaw(id, "blocks", [{ ...TEXT, stale: true }]);
        expect(((await JsonPageBase.findUnique({ where: { id } })) as any).blocks).toEqual([TEXT]);
      });
    });

    test("a $json key that is not a Json column throws", async () => {
      class Wrong extends JsonPageBase {
        static $json = { bookId: Style };
      }
      register("JsonPage", Wrong);
      await expect(Wrong.findMany({})).rejects.toThrow('JsonPage has no `Json` column named "bookId"');
    });
  });
}

suite("typed json columns (sqlite)");

if (POSTGRES_URL) {
  suite("typed json columns (postgres)", POSTGRES_URL);
} else {
  describe("typed json columns (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
