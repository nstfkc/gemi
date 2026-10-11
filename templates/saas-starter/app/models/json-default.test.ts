import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, register, type ModelSchema } from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * #926: a `Json` field's literal `@default` lands as the value it spells, not
 * as a JSON string.
 *
 * Prisma's DMMF hands a Json default over as its source text, so the generated
 * `schema.ts` records `{ kind: "value", value: "[]" }` — the specs below are
 * written exactly that way. gemi supplies `value` defaults itself, and used to
 * JSON-encode that text like any Json value: the column held the JSON *string*
 * `"[]"` (`jsonb_typeof` = `string`), and a migration that later ran
 * `jsonb_array_elements` over it failed with "cannot extract elements from a
 * scalar" in fager's production.
 *
 * Every assertion reads the column with the raw driver as well as through the
 * ORM. The ORM's own read is not enough on its own: on SQLite it decoded the
 * stored `"[]"` back to the string `"[]"`, which a `toEqual([])` does catch,
 * but the Postgres half is about what *other* readers of the column see.
 *
 * ```prisma
 * model JsonDefaultParent {
 *   id     Int                @id @default(autoincrement())
 *   things JsonDefaultThing[]
 * }
 *
 * model JsonDefaultThing {
 *   id       Int     @id @default(autoincrement())
 *   label    String  @default("[]")
 *   items    Json    @default("[]")
 *   body     Json    @default("{}")
 *   settings Json    @default("{\"theme\":\"dark\",\"tags\":[1,2]}")
 *   nothing  Json    @default("null")
 *   parentId Int?
 *   parent   JsonDefaultParent? @relation(fields: [parentId], references: [id])
 * }
 * ```
 *
 * `label` is a `String` whose default happens to look like JSON, and must stay
 * the two-character string.
 */

const SQLITE_DDL = [
  `CREATE TABLE "JsonDefaultParent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
  )`,
  `CREATE TABLE "JsonDefaultThing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "body" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{"theme":"dark","tags":[1,2]}',
    "nothing" JSONB NOT NULL DEFAULT 'null',
    "parentId" INTEGER,
    CONSTRAINT "JsonDefaultThing_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "JsonDefaultParent" ("id")
  )`,
];

const POSTGRES_DDL = [
  `CREATE TABLE "JsonDefaultParent" (
    "id" SERIAL NOT NULL PRIMARY KEY
  )`,
  `CREATE TABLE "JsonDefaultThing" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "body" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{"theme":"dark","tags":[1,2]}',
    "nothing" JSONB NOT NULL DEFAULT 'null',
    "docs" JSONB[] DEFAULT ARRAY['{"a":1}', '[]']::JSONB[],
    "parentId" INTEGER REFERENCES "JsonDefaultParent" ("id")
  )`,
];

function field(name: string, type: any, extra: Record<string, unknown> = {}): any {
  return {
    name,
    column: name,
    type,
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    ...extra,
  };
}

function thingSchema(postgres: boolean): ModelSchema {
  return {
    name: "JsonDefaultThing",
    table: "JsonDefaultThing",
    fields: {
      id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
      label: field("label", "String", { default: { kind: "value", value: "[]" } }),
      items: field("items", "Json", { default: { kind: "value", value: "[]" } }),
      body: field("body", "Json", { default: { kind: "value", value: "{}" } }),
      settings: field("settings", "Json", {
        default: { kind: "value", value: '{"theme":"dark","tags":[1,2]}' },
      }),
      // The JSON value null, in a NOT NULL column: SQL NULL would be refused.
      nothing: field("nothing", "Json", { default: { kind: "value", value: "null" } }),
      // `Json[]` is a validation error on SQLite, so only Postgres has it. The
      // DMMF gives a list default as an array of source texts.
      ...(postgres
        ? {
            docs: field("docs", "Json", {
              isList: true,
              nullable: true,
              default: { kind: "value", value: ['{"a":1}', "[]"] },
            }),
          }
        : {}),
      parentId: field("parentId", "Int", { nullable: true }),
    },
    primaryKey: ["id"],
    uniques: [],
    relations: {
      parent: {
        name: "parent",
        model: "JsonDefaultParent",
        kind: "one",
        relationName: "JsonDefaultParentToJsonDefaultThing",
        from: ["parentId"],
        to: ["id"],
        nullable: true,
      },
    },
  };
}

const parentSchema: ModelSchema = {
  name: "JsonDefaultParent",
  table: "JsonDefaultParent",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    things: {
      name: "things",
      model: "JsonDefaultThing",
      kind: "many",
      relationName: "JsonDefaultParentToJsonDefaultThing",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const DEFAULTS = {
  label: "[]",
  items: [],
  body: {},
  settings: { theme: "dark", tags: [1, 2] },
  nothing: null,
};

function suite(label: string, url?: string) {
  const postgres = url !== undefined;

  class Thing extends Model {
    static $schema = thingSchema(postgres);
  }
  class Parent extends Model {
    static $schema = parentSchema;
  }

  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-json-default-"));
        target = `sqlite://${join(workspace, "json-default.db")}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      await raw.unsafe(`DROP TABLE IF EXISTS "JsonDefaultThing"`);
      await raw.unsafe(`DROP TABLE IF EXISTS "JsonDefaultParent"`);
      for (const ddl of postgres ? POSTGRES_DDL : SQLITE_DDL) await raw.unsafe(ddl);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      register("JsonDefaultThing", Thing);
      register("JsonDefaultParent", Parent);
    }, 120_000);

    afterAll(async () => {
      await raw?.unsafe(`DROP TABLE IF EXISTS "JsonDefaultThing"`).catch(() => {});
      await raw?.unsafe(`DROP TABLE IF EXISTS "JsonDefaultParent"`).catch(() => {});
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      await raw.unsafe(`DELETE FROM "JsonDefaultThing"`);
      await raw.unsafe(`DELETE FROM "JsonDefaultParent"`);
    });

    /**
     * What the database holds, read past the ORM. On Postgres `jsonb_typeof`
     * is the question #926 is about; on SQLite the column is text, and the
     * text has to be the JSON of the value rather than the JSON of a string.
     */
    async function stored(id: number) {
      if (postgres) {
        const [row] = await raw.unsafe(
          `select jsonb_typeof("items") as items, jsonb_typeof("body") as body,
                  jsonb_typeof("settings") as settings, jsonb_typeof("nothing") as nothing,
                  (select array_agg(jsonb_typeof(d)) from unnest("docs") d) as docs,
                  "label"
             from "JsonDefaultThing" where "id" = $1`,
          [id],
        );
        return row;
      }
      const [row] = await raw.unsafe(
        `select "items", "body", "settings", "nothing", "label",
                json_type("items") as itemsType, json_type("body") as bodyType
           from "JsonDefaultThing" where "id" = ?`,
        [id],
      );
      return row;
    }

    async function expectDefaultsStored(id: number) {
      const row: any = await stored(id);
      expect(row.label).toBe("[]");
      if (postgres) {
        expect(row.items).toBe("array");
        expect(row.body).toBe("object");
        expect(row.settings).toBe("object");
        expect(row.nothing).toBe("null");
        expect(row.docs).toEqual(["object", "array"]);
      } else {
        expect(row.items).toBe("[]");
        expect(row.body).toBe("{}");
        expect(JSON.parse(row.settings)).toEqual(DEFAULTS.settings);
        expect(row.nothing).toBe("null");
        expect(row.itemsType).toBe("array");
        expect(row.bodyType).toBe("object");
      }

      const read: any = await Thing.$exec("findUniqueOrThrow", { where: { id } });
      expect(read).toMatchObject(DEFAULTS);
      if (postgres) expect(read.docs).toEqual([{ a: 1 }, []]);
    }

    test("create without the field stores a real array and object", async () => {
      const created: any = await Thing.$exec("create", { data: {} });

      expect(created).toMatchObject(DEFAULTS);
      await expectDefaultsStored(created.id);
    });

    test("createMany without the field stores a real array and object", async () => {
      await Thing.$exec("createMany", { data: [{}, { items: [1] }] });

      const rows: any[] = await Thing.$exec("findMany", { orderBy: { id: "asc" } });
      expect(rows).toHaveLength(2);
      await expectDefaultsStored(rows[0].id);
      expect(rows[1].items).toEqual([1]);
    });

    test("upsert's create branch stores a real array and object", async () => {
      const created: any = await Thing.$exec("upsert", {
        where: { id: 424242 },
        create: {},
        update: {},
      });

      await expectDefaultsStored(created.id);
    });

    test("a nested create stores a real array and object", async () => {
      const parent: any = await Parent.$exec("create", {
        data: { things: { create: [{}] } },
        include: { things: true },
      });

      expect(parent.things).toHaveLength(1);
      await expectDefaultsStored(parent.things[0].id);
    });

    test("a value passed in still beats the default", async () => {
      const created: any = await Thing.$exec("create", {
        data: { items: ["x"], body: { a: 1 }, label: "set" },
      });

      expect(created.items).toEqual(["x"]);
      expect(created.body).toEqual({ a: 1 });
      expect(created.label).toBe("set");
    });

    test("two rows do not share one default object", async () => {
      const one: any = await Thing.$exec("create", { data: {} });
      const two: any = await Thing.$exec("create", { data: {} });

      one.items.push("mutated");
      expect(two.items).toEqual([]);
    });
  });
}

suite("json defaults — sqlite");

if (POSTGRES_URL) {
  suite("json defaults — postgres", POSTGRES_URL);
} else {
  describe("json defaults — postgres", () => {
    test("SKIPPED — set TEST_POSTGRES_URL to run the Postgres dialect", () => {
      console.warn(
        "\n  ⚠  Postgres json default tests did NOT run.\n" +
          "     Set TEST_POSTGRES_URL to a scratch database to cover the " +
          "postgres dialect.\n",
      );
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}
