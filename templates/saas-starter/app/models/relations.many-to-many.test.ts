import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { Model, clearPlanCache, register, type ModelSchema } from "gemi/orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { POSTGRES_URL } from "./differential";

/**
 * Prisma's *implicit* many-to-many, which the template's own schema cannot
 * exercise — every relation in it is 1-1 or 1-n.
 *
 * An implicit m-n has no join *model*: Prisma creates a bare `_<RelationName>`
 * table with an `A` and a `B` column holding the two ids, the models in
 * alphabetical order. So the planner needs a two-hop load, and nothing in
 * `differential.test.ts` can reach it.
 *
 * This fixture is therefore a database rather than a Prisma client: the DDL
 * below is what `prisma migrate` emits for the two models in the comment, and
 * the assertions are against Prisma's documented result shape rather than
 * against a second generated client. That is the trade recorded in the PR —
 * covering the join-table logic for real, without a second `prisma generate` in
 * the test path. The shape rules it relies on (`[]` for an empty to-many, a
 * nested `select` keeping exactly its keys) are the same code the differential
 * suite pins against Prisma on the 1-n relations.
 *
 * ```prisma
 * model Post { id Int @id @default(autoincrement())  title String  tags Tag[] }
 * model Tag  { id Int @id @default(autoincrement())  label String  posts Post[] }
 * ```
 */

// Verbatim from `prisma migrate diff --from-empty --to-schema-datamodel`, so
// the table this test joins through is the table Prisma would have created,
// down to the index names.
const DDL = [
  `CREATE TABLE "Post" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL
)`,
  `CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL
)`,
  `CREATE TABLE "_PostToTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_PostToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PostToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`,
  `CREATE UNIQUE INDEX "_PostToTag_AB_unique" ON "_PostToTag"("A", "B")`,
  `CREATE INDEX "_PostToTag_B_index" ON "_PostToTag"("B")`,
];

// What the gemi generator emits for the two models above — confirmed by running
// `prisma generate` over that schema with the generator block, not assumed:
// neither side holds a foreign key, and both carry the same `joinTable`.
const JOIN_TABLE = { table: "_PostToTag", a: "Post", b: "Tag" };

const postSchema: ModelSchema = {
  name: "Post",
  table: "Post",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    title: { name: "title", column: "title", type: "String", nullable: false, isId: false, isUpdatedAt: false },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    tags: {
      name: "tags",
      model: "Tag",
      kind: "many",
      relationName: "PostToTag",
      from: [],
      to: [],
      nullable: false,
      joinTable: JOIN_TABLE,
    },
  },
};

const tagSchema: ModelSchema = {
  name: "Tag",
  table: "Tag",
  fields: {
    id: { name: "id", column: "id", type: "Int", nullable: false, isId: true, isUpdatedAt: false, default: { kind: "autoincrement" } },
    label: { name: "label", column: "label", type: "String", nullable: false, isId: false, isUpdatedAt: false },
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    posts: {
      name: "posts",
      model: "Post",
      kind: "many",
      relationName: "PostToTag",
      from: [],
      to: [],
      nullable: false,
      joinTable: JOIN_TABLE,
    },
  },
};

class Post extends Model {
  static $schema = postSchema;
  static findMany(args?: unknown) {
    return this.$exec("findMany", args) as Promise<Record<string, any>[]>;
  }
}

class Tag extends Model {
  static $schema = tagSchema;
  static findMany(args?: unknown) {
    return this.$exec("findMany", args) as Promise<Record<string, any>[]>;
  }
}

// The Postgres form of the same three tables, also verbatim from
// `prisma migrate diff`. The join hop is the one query the ORM assembles
// outside the compiler, so it is worth running on both dialects: the parent-key
// filter goes through the dialect's own `inList`, which is `in (?, ?)` on SQLite
// and `= any($1)` over an array literal here.
const PG_DDL = [
  `DROP TABLE IF EXISTS "_PostToTag"`,
  `DROP TABLE IF EXISTS "Post"`,
  `DROP TABLE IF EXISTS "Tag"`,
  `CREATE TABLE "Post" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE "_PostToTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_PostToTag_AB_pkey" PRIMARY KEY ("A","B")
)`,
  `CREATE INDEX "_PostToTag_B_index" ON "_PostToTag"("B")`,
  `ALTER TABLE "_PostToTag" ADD CONSTRAINT "_PostToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `ALTER TABLE "_PostToTag" ADD CONSTRAINT "_PostToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
];

// Post 1 carries two tags, post 2 one, post 3 none — the many / one / empty
// spread the 1-n cases use, and one tag nobody references.
const ROWS = [
  `INSERT INTO "Post" ("id", "title") VALUES (1, 'first'), (2, 'second'), (3, 'untagged')`,
  `INSERT INTO "Tag" ("id", "label") VALUES (1, 'red'), (2, 'blue'), (3, 'unused')`,
  `INSERT INTO "_PostToTag" ("A", "B") VALUES (1, 1), (1, 2), (2, 2)`,
];

let workspace: string | undefined;
let database: DatabaseManager;
let previous: Application | undefined;
let queries = 0;

async function setup(url: string, ddl: string[]) {
  const sql = new SQL(url);
  try {
    for (const statement of [...ddl, ...ROWS]) await sql.unsafe(statement);
  } finally {
    await sql.close();
  }

  previous = Application.getInstance();
  const app = new Application();
  database = new DatabaseManager({ url });
  // `$exec` resolves the manager per call and reads exactly `sql.unsafe` and
  // `dialect` off it, so a counting stand-in needs no cooperation from the ORM.
  app.instance(DatabaseManager, {
    dialect: database.dialect,
    url: database.url,
    sql: {
      unsafe(text: string, values: unknown[]) {
        queries++;
        return database.sql.unsafe(text, values);
      },
    },
  } as never);
  Application.setInstance(app);

  register("Post", Post);
  register("Tag", Tag);
  clearPlanCache();
}

async function teardown() {
  await database?.close();
  Application.setInstance(previous);
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}

function suite(label: string, start: () => Promise<void>) {
  describe(label, () => {
    beforeAll(start, 60_000);
    afterAll(teardown);
    cases();
  });
}

suite("implicit many-to-many — sqlite", async () => {
  workspace = mkdtempSync(join(tmpdir(), "gemi-orm-mn-"));
  await setup(`sqlite://${join(workspace, "mn.db")}`, DDL);
});

// Same contract as the differential suite's: a scratch database, and the tables
// this fixture owns are dropped and recreated in it.
const postgresUrl = POSTGRES_URL;
if (postgresUrl) {
  suite("implicit many-to-many — postgres", async () => {
    workspace = undefined;
    await setup(postgresUrl, PG_DDL);
  });
}

function cases() {
  test("loads through the join table, in both directions", async () => {
    const posts = await Post.findMany({
      orderBy: { id: "asc" },
      include: { tags: { orderBy: { id: "asc" } } },
    });

    expect(posts.map((post) => [post.title, post.tags.map((t: any) => t.label)]))
      .toEqual([
        ["first", ["red", "blue"]],
        ["second", ["blue"]],
        // Not null, not absent: an empty to-many is `[]`.
        ["untagged", []],
      ]);

    // The other side reads the same table through the *other* column, which is
    // the half a one-directional implementation gets wrong.
    const tags = await Tag.findMany({
      orderBy: { id: "asc" },
      include: { posts: { orderBy: { id: "asc" } } },
    });
    expect(tags.map((tag) => [tag.label, tag.posts.map((p: any) => p.title)]))
      .toEqual([
        ["red", ["first"]],
        ["blue", ["first", "second"]],
        ["unused", []],
      ]);
  });

  test("the relation's own arguments apply to the second hop", async () => {
    const posts = await Post.findMany({
      orderBy: { id: "asc" },
      include: { tags: { where: { label: "blue" } } },
    });
    expect(posts.map((post) => post.tags.map((t: any) => t.label))).toEqual([
      ["blue"],
      ["blue"],
      [],
    ]);

    // Descending, to prove the ordering is the child query's and not the join
    // table's row order.
    const ordered = await Post.findMany({
      where: { id: 1 },
      include: { tags: { orderBy: { label: "asc" } } },
    });
    expect(ordered[0].tags.map((t: any) => t.label)).toEqual(["blue", "red"]);
  });

  test("a nested select returns exactly its keys", async () => {
    const posts = await Post.findMany({
      where: { id: 1 },
      select: { title: true, tags: { select: { label: true } } },
    });

    // `Post.id` and `Tag.id` were both fetched to make the stitch possible and
    // both are gone again.
    expect(posts).toEqual([
      { title: "first", tags: [{ label: "red" }, { label: "blue" }] },
    ]);
  });

  test("two hops per node, not one per row", async () => {
    queries = 0;
    await Post.findMany({ include: { tags: true } });
    // root + the join table + the tags themselves.
    expect(queries).toBe(3);
  });

  test("the row hop is $exec on the related model's class", async () => {
    const spy = vi.spyOn(Tag, "$exec");
    try {
      await Post.findMany({ where: { id: 1 }, include: { tags: true } });
      // The join table has no model — it holds two foreign keys and nothing an
      // application could scope — but the hop that reads *rows* goes through
      // the choke point, so iteration 6's policies reach it.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("findMany");
    } finally {
      spy.mockRestore();
    }
  });

  test("no links means no second hop", async () => {
    queries = 0;
    await Post.findMany({ where: { id: 3 }, include: { tags: true } });
    // root + join table, and then nothing to fetch.
    expect(queries).toBe(2);
  });
}
