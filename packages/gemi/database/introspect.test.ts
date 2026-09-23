import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DB } from "../facades/DB";
import { Application } from "../foundation/Application";
import { DatabaseManager } from "./DatabaseManager";
import type { Dialect } from "./dialect";
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
  types: { int: string; slug: string; title: string };
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
  types: { int: "INTEGER", slug: "varchar(50)", title: "varchar(100)" },
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
          types: { int: "integer", slug: "character varying(50)", title: "character varying(100)" },
          titleDefault: "'untitled'::character varying",
        }),
      ]
    : []),
  ...(MYSQL_URL
    ? [
        server("mysql", "mysql", MYSQL_URL, {
          types: { int: "int", slug: "varchar(50)", title: "varchar(100)" },
          titleDefault: "untitled",
        }),
      ]
    : []),
  ...(MARIADB_URL
    ? [
        server("mariadb", "mariadb", MARIADB_URL, {
          types: { int: "int(11)", slug: "varchar(50)", title: "varchar(100)" },
          titleDefault: "'untitled'",
        }),
      ]
    : []),
];

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DB.schema() on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
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
    // Column order (orgId, slug) against key order (slug, orgId), so a key
    // read back in declaration order instead of key order is caught.
    await raw.unsafe(
      `create table ${q(Post)} (
        ${q("orgId")} ${intType} not null,
        ${q("slug")} varchar(50) not null,
        ${q("title")} varchar(100) null default 'untitled',
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
    const { int, slug, title } = backend.types;
    expect(table(Post)?.columns).toEqual([
      { name: "orgId", type: int, nullable: false, default: null },
      { name: "slug", type: slug, nullable: false, default: null },
      { name: "title", type: title, nullable: true, default: backend.titleDefault },
    ]);
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
