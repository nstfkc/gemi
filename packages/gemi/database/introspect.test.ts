import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { DatabaseManager } from "./DatabaseManager";
import type { Dialect } from "./dialect";
import { introspect } from "./introspect";
import type { DatabaseSchema } from "./introspect/types";

/**
 * `DB.schema()` against a real database of each kind: SQLite always, and the
 * servers whose URL this run has.
 *
 * The server databases are shared with every other suite in the run, so the
 * fixture tables carry a random, mixed-case prefix and the assertions look only
 * at them — never at the whole list.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;
const MARIADB_URL = process.env.TEST_MARIADB_URL;

type Backend = {
  name: string;
  dialect: Dialect;
  url(): { url: string; cleanup(): void };
  /** The database's own spelling of the fixture's types. */
  types: { int: string; slug: string; title: string; note: string; tax: string };
  titleDefault: string;
};

const sqlite: Backend = {
  name: "sqlite",
  dialect: "sqlite",
  url() {
    const dir = mkdtempSync(join(tmpdir(), "gemi-introspect-"));
    return {
      url: `sqlite://${join(dir, "schema.db")}`,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  types: {
    int: "INTEGER",
    slug: "varchar(50)",
    title: "varchar(100)",
    note: "varchar(20)",
    tax: "INTEGER",
  },
  titleDefault: "'untitled'",
};

const server = (
  name: string,
  dialect: Dialect,
  url: string,
  rest: Pick<Backend, "types" | "titleDefault">,
): Backend => ({
  name,
  dialect,
  url: () => ({ url, cleanup() {} }),
  ...rest,
});

const backends: Backend[] = [
  sqlite,
  ...(POSTGRES_URL
    ? [
        server("postgres", "postgres", POSTGRES_URL, {
          types: {
            int: "integer",
            slug: "character varying(50)",
            title: "character varying(100)",
            note: "character varying(20)",
            tax: "integer",
          },
          titleDefault: "'untitled'::character varying",
        }),
      ]
    : []),
  ...(MYSQL_URL
    ? [
        server("mysql", "mysql", MYSQL_URL, {
          types: {
            int: "int",
            slug: "varchar(50)",
            title: "varchar(100)",
            note: "varchar(20)",
            tax: "int",
          },
          titleDefault: "untitled",
        }),
      ]
    : []),
  ...(MARIADB_URL
    ? [
        server("mariadb", "mariadb", MARIADB_URL, {
          types: {
            int: "int(11)",
            slug: "varchar(50)",
            title: "varchar(100)",
            note: "varchar(20)",
            tax: "int(11)",
          },
          titleDefault: "'untitled'",
        }),
      ]
    : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  const missing = [POSTGRES_URL ? null : "TEST_POSTGRES_URL", MYSQL_URL ? null : "TEST_MYSQL_URL"]
    .filter((name) => name !== null)
    .join(" and ");
  describe("DB.schema() on the servers this run has no URL for", () => {
    // CI runs this file a second time filtered to `-t "postgres|mysql"`, purely
    // to reach the server catalogs. With no URL that selects this notice and
    // nothing else, and a step that ran no test reads as a pass — the same
    // silence `postgres-suite-selection.test.ts` exists to catch. So the job
    // that means to reach the servers sets the variable below, and there a
    // missing URL fails rather than skips.
    const name = `postgres ${POSTGRES_URL ? "ran" : "did NOT run"}, mysql ${
      MYSQL_URL ? "ran" : "did NOT run"
    }: set ${missing}`;
    if (process.env.CI_DATABASE_SERVERS_REQUIRED === "1") {
      test(name, () => {
        throw new Error(`This run must reach Postgres and MySQL. Not set: ${missing}.`);
      });
    } else {
      test.skip(name, () => {});
    }
  });
}

describe.each(backends)("DB.schema() on $name", (backend) => {
  const mysqlFamily = backend.dialect === "mysql" || backend.dialect === "mariadb";
  const q = (name: string) => (mysqlFamily ? `\`${name}\`` : `"${name}"`);
  const prefix = `Gi${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}_`;
  const Owner = `${prefix}Owner`;
  const Post = `${prefix}Post`;
  const Comment = `${prefix}Comment`;
  const View = `${prefix}View`;
  const Scratch = `${prefix}Scratch`;

  let target: ReturnType<Backend["url"]>;
  let raw: SQL;
  let database: DatabaseManager;
  let previous: Application | undefined;
  let schema: DatabaseSchema;

  const table = (name: string) => schema.tables.find((t) => t.name === name);

  beforeAll(async () => {
    target = backend.url();
    raw = new SQL(target.url);
    const intType = backend.dialect === "sqlite" ? "integer" : "int";

    await raw.unsafe(`create table ${q(Owner)} (${q("id")} ${intType} primary key)`);
    // Declaration order (title, orgId, slug, note, tax) is deliberately neither
    // key order (slug, orgId) nor alphabetical, so a read that sorts by either
    // instead of keeping the declaration is caught.
    //
    // `note` is nullable with no default, which MariaDB alone spells as the
    // string `NULL`; `tax` is generated, which one catalog reports as a column
    // and another leaves out.
    await raw.unsafe(
      `create table ${q(Post)} (
        ${q("title")} varchar(100) null default 'untitled',
        ${q("orgId")} ${intType} not null,
        ${q("slug")} varchar(50) not null,
        ${q("note")} varchar(20) null,
        ${q("tax")} ${intType} generated always as (${q("orgId")} * 2) stored,
        primary key (${q("slug")}, ${q("orgId")})
      )`,
    );
    // SQLite may leave the referenced columns out, meaning the parent's key;
    // the others insist on a list.
    const ownerRef =
      backend.dialect === "sqlite"
        ? `references ${q(Owner)}`
        : `references ${q(Owner)} (${q("id")})`;
    await raw.unsafe(
      `create table ${q(Comment)} (
        ${q("id")} ${intType} primary key,
        ${q("postSlug")} varchar(50) not null,
        ${q("postOrg")} ${intType} not null,
        ${q("ownerId")} ${intType} null,
        constraint ${q(`${prefix}comment_post`)} foreign key (${q("postSlug")}, ${q("postOrg")})
          references ${q(Post)} (${q("slug")}, ${q("orgId")}) on delete cascade,
        constraint ${q(`${prefix}comment_owner`)} foreign key (${q("ownerId")}) ${ownerRef}
      )`,
    );
    await raw.unsafe(`create view ${q(View)} as select * from ${q(Owner)}`);

    database = new DatabaseManager({ url: target.url });
    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    schema = await DB.schema();
  }, 60_000);

  afterAll(async () => {
    await raw?.unsafe(`drop view if exists ${q(View)}`);
    for (const name of [Scratch, Comment, Post, Owner]) {
      await raw?.unsafe(`drop table if exists ${q(name)}`);
    }
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    target?.cleanup();
  });

  test("reports the dialect and sorts the tables", () => {
    expect(schema.dialect).toBe(backend.dialect);
    const names = schema.tables.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining([Owner, Post, Comment]));
  });

  test("leaves views out", () => {
    expect(table(View)).toBeUndefined();
  });

  test("reads columns in declaration order, with type, nullability and default", () => {
    const { int, slug, title, note, tax } = backend.types;
    expect(table(Post)?.columns).toEqual([
      { name: "title", type: title, nullable: true, default: backend.titleDefault },
      { name: "orgId", type: int, nullable: false, default: null },
      { name: "slug", type: slug, nullable: false, default: null },
      // No default, rather than MariaDB's spelling of one.
      { name: "note", type: note, nullable: true, default: null },
      // Listed like any other column, and its expression is not a default.
      { name: "tax", type: tax, nullable: true, default: null },
    ]);
  });

  test("a generated column is one a plain select returns", async () => {
    await raw.unsafe(
      `insert into ${q(Post)} (${q("orgId")}, ${q("slug")}) values (21, 'generated')`,
    );
    const [row] = (await raw.unsafe(
      `select * from ${q(Post)} where ${q("slug")} = 'generated'`,
    )) as Array<Record<string, unknown>>;
    expect(Object.keys(row).sort()).toEqual(
      [...(table(Post)?.columns ?? [])].map((c) => c.name).sort(),
    );
    expect(Number(row.tax)).toBe(42);
  });

  test("reads a composite primary key in key order, not column order", () => {
    expect(table(Post)?.primaryKey).toEqual(["slug", "orgId"]);
    expect(table(Owner)?.primaryKey).toEqual(["id"]);
  });

  test("a key column is not nullable", () => {
    expect(table(Owner)?.columns).toEqual([
      { name: "id", type: backend.types.int, nullable: false, default: null },
    ]);
  });

  test("reads foreign keys as relations, composite ones paired by position", () => {
    const relations = [...(table(Comment)?.relations ?? [])].sort((a, b) =>
      a.referencedTable.localeCompare(b.referencedTable),
    );
    const named = backend.dialect !== "sqlite";
    expect(relations).toEqual([
      {
        name: named ? `${prefix}comment_owner` : null,
        columns: ["ownerId"],
        referencedTable: Owner,
        // On SQLite the DDL left this out; it is resolved to the parent's key.
        referencedColumns: ["id"],
        onDelete: expect.stringMatching(/^(NO ACTION|RESTRICT)$/),
        onUpdate: expect.stringMatching(/^(NO ACTION|RESTRICT)$/),
      },
      {
        name: named ? `${prefix}comment_post` : null,
        columns: ["postSlug", "postOrg"],
        referencedTable: Post,
        referencedColumns: ["slug", "orgId"],
        onDelete: "CASCADE",
        onUpdate: expect.stringMatching(/^(NO ACTION|RESTRICT)$/),
      },
    ]);
    expect(table(Post)?.relations).toEqual([]);
  });

  test("a named connection gives the same answer", async () => {
    const named = await DB.connection("default").schema();
    expect(named.tables.filter((t) => t.name.startsWith(prefix))).toEqual(
      schema.tables.filter((t) => t.name.startsWith(prefix)),
    );
  });

  test("inside a transaction, sees a table the transaction created", async () => {
    const seen = await DB.transaction(async (tx) => {
      await tx.unsafe(`create table ${q(Scratch)} (${q("id")} int primary key)`);
      return (await DB.schema()).tables.some((t) => t.name === Scratch);
    });
    expect(seen).toBe(true);
  });

  test("an unknown connection rejects rather than throwing", async () => {
    await expect(DB.connection("nope").schema()).rejects.toThrow(/nope/);
  });
});

/**
 * The quirks only SQLite has, read through the reader rather than the facade:
 * the facade path is the same one the suite above exercises on every dialect,
 * and what is under test here is the catalog reading.
 */
describe("DB.schema() on sqlite's own quirks", () => {
  let dir: string;
  let raw: SQL;
  let schema: DatabaseSchema;

  const table = (name: string) => schema.tables.find((t) => t.name === name);
  const relations = (name: string) =>
    [...(table(name)?.relations ?? [])].sort((a, b) =>
      a.referencedTable.localeCompare(b.referencedTable),
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gemi-introspect-sqlite-"));
    raw = new SQL(`sqlite://${join(dir, "quirks.db")}`);
    await raw.unsafe(`create table "Owner" ("id" integer primary key)`);
    await raw.unsafe(
      `create table "Pair" ("a" int not null, "b" int not null, primary key ("a", "b"))`,
    );
    // SQLite compares identifiers case-insensitively, so both of these name the
    // tables above however the DDL spells them, and neither gives a column list.
    await raw.unsafe(
      `create table "Loose" (
        "o" integer references OWNER,
        "x" int, "y" int,
        foreign key ("x", "y") references pair
      )`,
    );
    await raw.unsafe(`create table "TextKey" ("k" text primary key)`);
    await raw.unsafe(`create virtual table "Fts" using fts5(body)`);
    schema = await introspect(raw, "sqlite");
  }, 60_000);

  afterAll(async () => {
    await raw?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves a key whose parent is named in another case", () => {
    expect(relations("Loose")).toEqual([
      {
        name: null,
        columns: ["o"],
        referencedTable: "Owner",
        referencedColumns: ["id"],
        onDelete: expect.any(String),
        onUpdate: expect.any(String),
      },
      {
        name: null,
        columns: ["x", "y"],
        referencedTable: "Pair",
        referencedColumns: ["a", "b"],
        onDelete: expect.any(String),
        onUpdate: expect.any(String),
      },
    ]);
    // The point of reporting the catalog's spelling: a relation can be looked
    // up in the same read's tables, which is what the docs show.
    for (const relation of relations("Loose")) {
      expect(schema.tables.map((t) => t.name)).toContain(relation.referencedTable);
    }
  });

  test("a key that is not the rowid is nullable, because the table lets it be", async () => {
    await raw.unsafe(`insert into "TextKey" values (null)`);
    const rows = (await raw.unsafe(`select * from "TextKey"`)) as Array<{ k: string | null }>;
    expect([...rows]).toEqual([{ k: null }]);

    expect(table("TextKey")?.columns).toEqual([
      { name: "k", type: "TEXT", nullable: true, default: null },
    ]);
    // A sole `integer primary key` is the rowid, which fills a null in, so that
    // one is not nullable.
    expect(table("Owner")?.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false, default: null },
    ]);
  });

  test("leaves a virtual table and the shadow tables behind it out", () => {
    expect(schema.tables.map((t) => t.name)).toEqual(["Loose", "Owner", "Pair", "TextKey"]);
  });
});

/**
 * A key may point at a table this read does not list, because it lives in
 * another schema. SQLite has no second schema to point into.
 */
describe.each(backends.filter((b) => b.dialect !== "sqlite"))(
  "DB.schema() on $name, a key into another schema",
  (backend) => {
    const mysqlFamily = backend.dialect === "mysql" || backend.dialect === "mariadb";
    const q = (name: string) => (mysqlFamily ? `\`${name}\`` : `"${name}"`);
    const prefix = `Gx${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}_`;
    const Other = `${prefix}other`;
    const Kid = `${prefix}Kid`;
    // The same bare name in this schema, which the relation must not be read as.
    const Decoy = "Thing";

    let raw: SQL;
    let schema: DatabaseSchema;

    beforeAll(async () => {
      raw = new SQL(backend.url().url);
      await raw.unsafe(`create ${mysqlFamily ? "database" : "schema"} ${q(Other)}`);
      await raw.unsafe(`create table ${q(Other)}.${q(Decoy)} (${q("b1")} int primary key)`);
      await raw.unsafe(
        `create table ${q(Kid)} (
          ${q("id")} int primary key,
          ${q("t")} int,
          constraint ${q(`${prefix}fk`)} foreign key (${q("t")})
            references ${q(Other)}.${q(Decoy)} (${q("b1")})
        )`,
      );
      schema = await introspect(raw, backend.dialect);
    }, 60_000);

    afterAll(async () => {
      await raw?.unsafe(`drop table if exists ${q(Kid)}`);
      await raw?.unsafe(
        `drop ${mysqlFamily ? "database" : "schema"} if exists ${q(Other)} ${mysqlFamily ? "" : "cascade"}`,
      );
      await raw?.close();
    });

    test("qualifies the parent with its schema, so it reads as out of scope", () => {
      const [relation] = schema.tables.find((t) => t.name === Kid)!.relations;
      expect(relation.referencedTable).toBe(`${Other}.${Decoy}`);
      expect(relation.referencedColumns).toEqual(["b1"]);
      expect(schema.tables.map((t) => t.name)).not.toContain(relation.referencedTable);
    });
  },
);
