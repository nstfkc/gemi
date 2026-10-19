import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { s } from "gemi/ai";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  InvalidArgumentError,
  Model,
  ScalarColumnError,
  clearPlanCache,
  register,
  type ModelSchema,
} from "gemi/orm";
import { Encrypter } from "gemi/services";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * Typed scalar columns (#1001) against a real database: `static $columns` on
 * a model parses each `String` column on every read path (find, select,
 * include under both strategies, the rows a write returns) and validates it
 * on every write, while `where` keeps filtering on the stored string.
 *
 * The models are declared here, with the metadata the generator emits for
 *
 *     model ScSite {
 *       id Int @id @default(autoincrement())
 *       title String
 *       format String
 *       style String?
 *       mood String?
 *       /// @gemi.encrypted
 *       secret String?
 *       posts ScPost[]
 *     }
 *     model ScPost {
 *       id Int @id @default(autoincrement())
 *       siteId Int
 *       site ScSite @relation(fields: [siteId], references: [id])
 *       format String
 *     }
 */

const field = (name: string, type: string, nullable: boolean, extra: Record<string, unknown> = {}) => ({
  name,
  column: name,
  type,
  nullable,
  isId: false,
  isUpdatedAt: false,
  ...extra,
});

const siteSchema: ModelSchema = {
  name: "ScSite",
  table: "ScSite",
  fields: {
    id: { ...field("id", "Int", false), isId: true, default: { kind: "autoincrement" } },
    title: field("title", "String", false),
    format: field("format", "String", false),
    style: field("style", "String", true),
    mood: field("mood", "String", true),
    secret: field("secret", "String", true, { encrypted: true }),
  } as ModelSchema["fields"],
  primaryKey: ["id"],
  uniques: [],
  relations: {
    posts: { name: "posts", model: "ScPost", kind: "many", relationName: "ScSiteToScPost", from: [], to: [], nullable: false },
  },
};

const postSchema: ModelSchema = {
  name: "ScPost",
  table: "ScPost",
  fields: {
    id: { ...field("id", "Int", false), isId: true, default: { kind: "autoincrement" } },
    siteId: field("siteId", "Int", false),
    format: field("format", "String", false),
  } as ModelSchema["fields"],
  primaryKey: ["id"],
  uniques: [],
  relations: {
    site: { name: "site", model: "ScSite", kind: "one", relationName: "ScSiteToScPost", from: ["siteId"], to: ["id"], nullable: false },
  },
};

type Args = Record<string, unknown>;
type Options = Record<string, unknown> | undefined;
abstract class Ops extends Model {
  static findMany(args?: Args, options?: Options) { return this.$exec("findMany", args, options as never); }
  static findFirst(args?: Args, options?: Options) { return this.$exec("findFirst", args, options as never); }
  static findUnique(args: Args, options?: Options) { return this.$exec("findUnique", args, options as never); }
  static count(args?: Args) { return this.$exec("count", args); }
  static delete(args: Args) { return this.$exec("delete", args); }
  static create(args: Args) { return this.$exec("create", args); }
  static createMany(args: Args) { return this.$exec("createMany", args); }
  static update(args: Args, options?: Options) { return this.$exec("update", args, options as never); }
  static updateMany(args: Args) { return this.$exec("updateMany", args); }
  static upsert(args: Args) { return this.$exec("upsert", args); }
}

const FORMATS = ["post", "story", "reel"] as const;
const STYLES = ["minimal", "bold"] as const;

/** What the generator would emit. */
class ScSiteBase extends Ops {
  static $schema = siteSchema;
}

/** The app's model, with the column schemas. */
class ScSite extends ScSiteBase {
  static $columns = {
    format: s.enum(FORMATS),
    style: { schema: s.enum(STYLES), invalid: "null" as const },
    mood: { schema: s.enum(["calm", "warm"]), invalid: (value: unknown) => (value === "sunny" ? "warm" : "calm") },
    secret: s.enum(["a", "b"]),
  };
}

class ScPost extends Ops {
  static $schema = postSchema;
  static $columns = { format: { schema: s.enum(FORMATS), invalid: "null" as const } };
}

const DDL = {
  sqlite: [
    `CREATE TABLE "ScSite" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "title" TEXT NOT NULL, "format" TEXT NOT NULL, "style" TEXT, "mood" TEXT, "secret" TEXT)`,
    `CREATE TABLE "ScPost" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "siteId" INTEGER NOT NULL REFERENCES "ScSite"("id"), "format" TEXT NOT NULL)`,
  ],
  postgres: [
    `DROP TABLE IF EXISTS "ScPost"`,
    `DROP TABLE IF EXISTS "ScSite"`,
    `CREATE TABLE "ScSite" ("id" SERIAL PRIMARY KEY, "title" TEXT NOT NULL, "format" TEXT NOT NULL, "style" TEXT, "mood" TEXT, "secret" TEXT)`,
    `CREATE TABLE "ScPost" ("id" SERIAL PRIMARY KEY, "siteId" INTEGER NOT NULL REFERENCES "ScSite"("id"), "format" TEXT NOT NULL)`,
  ],
};

const STRATEGIES = ["batched", "lateral"] as const;
const key = randomBytes(32).toString("base64");

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    const storeRaw = (table: string, id: number, column: string, value: string | null) =>
      raw.unsafe(
        `UPDATE "${table}" SET "${column}" = ${value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`} WHERE "id" = ${Number(id)}`,
      );
    const stored = async (id: number, column: string) =>
      ((await raw.unsafe(`SELECT "${column}" FROM "ScSite" WHERE "id" = ${Number(id)}`)) as any[])[0][column];

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-scalar-columns-"));
        target = `sqlite://${join(workspace, "scalar.db")}`;
      }
      database = new DatabaseManager({ url: target });
      raw = new SQL(target);
      for (const statement of url ? DDL.postgres : DDL.sqlite) await raw.unsafe(statement);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      application.instance(Encrypter, new Encrypter({ keys: { key } }) as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      if (url) {
        await raw.unsafe(`DROP TABLE IF EXISTS "ScPost"`);
        await raw.unsafe(`DROP TABLE IF EXISTS "ScSite"`);
      }
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      register("ScSite", ScSite);
      register("ScPost", ScPost);
      await raw.unsafe(`DELETE FROM "ScPost"`);
      await raw.unsafe(`DELETE FROM "ScSite"`);
    });

    const createSite = (data: Record<string, unknown> = {}) =>
      ScSite.create({ data: { title: "t", format: "post", ...data } }) as Promise<Record<string, any>>;

    describe("writes", () => {
      test("a valid value is written as is", async () => {
        const created = await createSite({ format: "reel", style: "bold" });
        expect(created).toMatchObject({ format: "reel", style: "bold" });
        expect(await stored(created.id, "format")).toBe("reel");
      });

      test("an invalid value throws before the query, on every write", async () => {
        await expect(createSite({ format: "video" })).rejects.toThrow(InvalidArgumentError);
        await expect(createSite({ format: "video" })).rejects.toThrow("ScSite.format does not match its schema");
        const { id } = await createSite();
        await expect(ScSite.update({ where: { id }, data: { style: "loud" } })).rejects.toThrow(InvalidArgumentError);
        await expect(ScSite.update({ where: { id }, data: { style: { set: "loud" } } })).rejects.toThrow(InvalidArgumentError);
        await expect(ScSite.updateMany({ where: {}, data: { format: 1 } })).rejects.toThrow(InvalidArgumentError);
        await expect(
          ScSite.createMany({ data: [{ title: "a", format: "post" }, { title: "b", format: "nope" }] }),
        ).rejects.toThrow(InvalidArgumentError);
        await expect(
          ScSite.upsert({ where: { id }, create: { title: "u", format: "post" }, update: { format: "nope" } }),
        ).rejects.toThrow(InvalidArgumentError);
        await expect(
          ScSite.upsert({ where: { id: 999_999 }, create: { title: "u", format: "nope" }, update: {} }),
        ).rejects.toThrow(InvalidArgumentError);
        expect(await ScSite.count({})).toBe(1);
        expect(await stored(id, "style")).toBeNull();
      });

      test("{ set } on an update is validated and written", async () => {
        const { id } = await createSite();
        const updated = (await ScSite.update({ where: { id }, data: { format: { set: "story" } } })) as any;
        expect(updated.format).toBe("story");
        expect(await stored(id, "format")).toBe("story");
      });

      test("null passes on a nullable column and is refused on a non-nullable one", async () => {
        const { id } = await createSite({ style: "bold" });
        expect(((await ScSite.update({ where: { id }, data: { style: null } })) as any).style).toBeNull();
        expect(((await ScSite.update({ where: { id }, data: { style: { set: null } } })) as any).style).toBeNull();
        await expect(ScSite.update({ where: { id }, data: { format: null } })).rejects.toThrow("ScSite.format is not nullable");
      });

      test("a nested write into the model is validated by the model", async () => {
        const { id } = await createSite();
        await expect(
          ScSite.update({ where: { id }, data: { posts: { create: [{ format: "nope" }] } } }),
        ).rejects.toThrow(InvalidArgumentError);
        await ScSite.update({ where: { id }, data: { posts: { create: [{ format: "reel" }] } } });
        expect(((await ScPost.findMany({})) as any[]).map((post) => post.format)).toEqual(["reel"]);
      });

      test("an encrypted typed column is validated as plaintext and decrypted before it is parsed", async () => {
        const created = await createSite({ secret: "a" });
        expect(created.secret).toBe("a");
        expect(await stored(created.id, "secret")).not.toBe("a");
        expect(((await ScSite.findUnique({ where: { id: created.id } })) as any).secret).toBe("a");
        await expect(createSite({ secret: "c" })).rejects.toThrow(InvalidArgumentError);
      });
    });

    describe("reads", () => {
      test("find and select answer the parsed value", async () => {
        const { id } = await createSite({ style: "bold" });
        expect(await ScSite.findUnique({ where: { id } })).toMatchObject({ format: "post", style: "bold", mood: null });
        expect(await ScSite.findFirst({ where: { id }, select: { format: true } })).toEqual({ format: "post" });
      });

      test('a stored value the schema refuses throws by default, answers null with invalid: "null", or the fallback', async () => {
        const { id } = await createSite();
        await storeRaw("ScSite", id, "style", "retired");
        await storeRaw("ScSite", id, "mood", "sunny");
        expect(await ScSite.findUnique({ where: { id } })).toMatchObject({ style: null, mood: "warm" });

        await storeRaw("ScSite", id, "format", "retired");
        const error = (await ScSite.findUnique({ where: { id } }).catch((e: unknown) => e)) as ScalarColumnError;
        expect(error).toBeInstanceOf(ScalarColumnError);
        expect(error.column).toEqual({ model: "ScSite", field: "format" });
        expect(error.value).toBe("retired");
      });

      test("where filters on the stored string, including values the schema refuses", async () => {
        const { id } = await createSite({ style: "bold" });
        await storeRaw("ScSite", id, "style", "retired");
        const found = (await ScSite.findMany({ where: { style: "retired" } })) as any[];
        expect(found.map((row) => [row.id, row.style])).toEqual([[id, null]]);
        expect(await ScSite.count({ where: { style: { in: ["retired", "x"] } } })).toBe(1);
        expect(await ScSite.count({ where: { format: { startsWith: "po" } } })).toBe(1);
      });

      test("upsert answers the parsed row on both branches", async () => {
        const { id } = await createSite();
        await storeRaw("ScSite", id, "style", "retired");
        const updated = (await ScSite.upsert({
          where: { id },
          create: { title: "u", format: "post" },
          update: { format: "reel" },
        })) as any;
        expect(updated).toMatchObject({ id, format: "reel", style: null });
        const created = (await ScSite.upsert({
          where: { id: 999_999 },
          create: { title: "u", format: "story" },
          update: {},
        })) as any;
        expect(created.format).toBe("story");
      });

      for (const strategy of STRATEGIES) {
        test(`an include and an include under select (${strategy})`, async () => {
          const { id } = await createSite();
          const post = (await ScPost.create({ data: { siteId: id, format: "post" } })) as any;
          await raw.unsafe(`UPDATE "ScPost" SET "format" = 'retired' WHERE "id" = ${Number(post.id)}`);
          await storeRaw("ScSite", id, "style", "retired");

          const included = (await ScSite.findMany({ include: { posts: true } }, { strategy })) as any[];
          expect(included[0].style).toBeNull();
          expect(included[0].posts[0].format).toBeNull();

          const selected = (await ScSite.findMany(
            { select: { style: true, posts: { select: { format: true } } } },
            { strategy },
          )) as any[];
          expect(selected).toEqual([{ style: null, posts: [{ format: null }] }]);

          const parents = (await ScPost.findMany({ include: { site: true } }, { strategy })) as any[];
          expect(parents[0]).toMatchObject({ format: null, site: { style: null, format: "post" } });
        });
      }

      test("a read through the generated base parses the registered model's columns", async () => {
        const { id } = await createSite();
        await storeRaw("ScSite", id, "style", "retired");
        expect(((await ScSiteBase.findUnique({ where: { id } })) as any).style).toBeNull();
      });
    });

    describe('a write on a row holding a value its schema refuses (invalid: "throw")', () => {
      let id: number;

      beforeEach(async () => {
        id = (await createSite()).id;
        await storeRaw("ScSite", id, "format", "retired");
        await expect(ScSite.findUnique({ where: { id } })).rejects.toThrow(ScalarColumnError);
      });

      test("update saves and answers the stored value", async () => {
        const updated = (await ScSite.update({ where: { id }, data: { style: "bold" } })) as any;
        expect(updated).toMatchObject({ format: "retired", style: "bold" });
      });

      test("update can fix the row", async () => {
        await ScSite.update({ where: { id }, data: { format: "post" } });
        expect(((await ScSite.findUnique({ where: { id } })) as any).format).toBe("post");
      });

      test("delete deletes and answers the stored value", async () => {
        expect(((await ScSite.delete({ where: { id } })) as any).format).toBe("retired");
        expect(await ScSite.count({})).toBe(0);
      });
    });

    describe("declaration", () => {
      test("a $columns key that is not a String column throws", async () => {
        class Wrong extends ScSiteBase {
          static $columns = { id: s.enum(["1"]) };
        }
        register("ScSite", Wrong);
        await expect(Wrong.findMany({})).rejects.toThrow('ScSite has no `String` column named "id"');
      });

      test("a $columns value that is not a schema throws", async () => {
        class Wrong extends ScSiteBase {
          static $columns = { format: { invalid: "null" } } as never;
        }
        register("ScSite", Wrong as never);
        await expect(Wrong.findMany({})).rejects.toThrow("ScSite.$columns.format must be a schema");
      });

      test("a String column in $json points at $columns", async () => {
        class Wrong extends ScSiteBase {
          static $json = { format: s.enum(FORMATS) };
        }
        register("ScSite", Wrong);
        await expect(Wrong.findMany({})).rejects.toThrow("declare a `String` column in `static $columns`");
      });
    });
  });
}

suite("typed scalar columns (sqlite)");

if (POSTGRES_URL) {
  suite("typed scalar columns (postgres)", POSTGRES_URL);
} else {
  describe("typed scalar columns (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
