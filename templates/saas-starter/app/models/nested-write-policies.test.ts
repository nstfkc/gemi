import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  RecordNotFoundError,
  clearPlanCache,
  register,
  type ModelPolicy,
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * Policies on **nested writes** — `data: { children: { create: … } }` and
 * `data: { parent: { connect: … } }`.
 *
 * The rule this project keeps rediscovering, arriving from a fifth direction:
 * *if a statement reaches another model's rows, that model's policies belong in
 * it.* Nested includes were the first, the lateral strategy's folded subquery
 * the second, relation filters and `_count` the third and fourth, relation
 * orderings the fifth. This is the sixth, and the first on the **write** side —
 * where the failure is not a leak but an unscoped row being *written*.
 *
 * Two shapes, and they fail differently:
 *
 * - **nested `create`** goes through the child's `$exec`, so its `onCreate`
 *   should default the scoped column. Unscoped, it writes the row with the
 *   column unset — no error, wrong tenant.
 * - **nested `connect` by a non-referenced unique key** resolves through a
 *   `findUniqueOrThrow` on the target. Unscoped, that lookup can find another
 *   tenant's row and attach it.
 *
 * `orgId` is nullable on purpose. Making it `NOT NULL` would turn the first case
 * into a database error, which is a fine outcome and a bad test: it would pass
 * for a reason that has nothing to do with policies, and it would keep passing
 * if the scope stopped being applied.
 */

const DDL = [
  `DROP TABLE IF EXISTS "Note"`,
  `DROP TABLE IF EXISTS "Folder"`,
  `CREATE TABLE "Folder" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "code" TEXT NOT NULL UNIQUE,
     "orgId" INTEGER
   )`,
  `CREATE TABLE "Note" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "folderId" INTEGER,
     "label" TEXT NOT NULL,
     "orgId" INTEGER
   )`,
];

function field(name: string, type: any, extra: Record<string, unknown> = {}) {
  return {
    name,
    column: name,
    type,
    nullable: false,
    isId: false,
    isUpdatedAt: false,
    ...extra,
  } as any;
}

const folderSchema: ModelSchema = {
  name: "Folder",
  table: "Folder",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    code: field("code", "String"),
    orgId: field("orgId", "Int", { nullable: true }),
  },
  primaryKey: ["id"],
  uniques: [["code"]],
  relations: {
    notes: {
      name: "notes",
      model: "Note",
      kind: "many",
      relationName: "FolderToNote",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const noteSchema: ModelSchema = {
  name: "Note",
  table: "Note",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    folderId: field("folderId", "Int", { nullable: true }),
    label: field("label", "String"),
    orgId: field("orgId", "Int", { nullable: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    folder: {
      name: "folder",
      model: "Folder",
      kind: "one",
      relationName: "FolderToNote",
      from: ["folderId"],
      to: ["id"],
      nullable: true,
    },
  },
};

const tenant = (): ModelPolicy => ({
  scope: (context) => ({ orgId: (context.user as any).orgId }),
  onCreate: (context, data) => ({
    ...data,
    orgId: (context.user as any).orgId,
  }),
});

class Folder extends Model {
  static $schema = folderSchema;
  static $policy = tenant();
}

class Note extends Model {
  static $schema = noteSchema;
  static $policy = tenant();
}

const OURS = { orgId: 7 };

describe("policies on nested writes", () => {
  let workspace: string;
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-nested-"));
    const url = `sqlite://${join(workspace, "nested.db")}`;

    database = new DatabaseManager({ url });
    raw = new SQL(url);
    for (const statement of DDL) await raw.unsafe(statement);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    register("Folder", Folder);
    register("Note", Note);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Note"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Folder"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`DELETE FROM "Note"`);
    await raw.unsafe(`DELETE FROM "Folder"`);
    // A folder belonging to somebody else, reachable only by its unique `code`.
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (1, 'theirs', 99)`,
    );
  });

  /**
   * The child is created through its own `$exec`, so its `onCreate` has to run.
   * Without it the row lands with `orgId` unset — no error, and it belongs to
   * nobody.
   */
  test("a nested create carries the child's onCreate", async () => {
    await Model.asUser(OURS, () =>
      Folder.$exec("create", {
        data: { code: "ours", notes: { create: { label: "n" } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect(notes).toHaveLength(1);
    expect(notes[0].orgId).toBe(7);
  });

  /**
   * `connect` by a unique key that is *not* the referenced field resolves with a
   * `findUniqueOrThrow` on the target — a read of another model, and therefore
   * that model's policies. Unscoped, this attaches org 99's folder to org 7's
   * note.
   */
  test("a nested connect cannot reach another tenant's row", async () => {
    await expect(
      Model.asUser(OURS, () =>
        Note.$exec("create", {
          data: { label: "n", folder: { connect: { code: "theirs" } } },
        }),
      ),
    ).rejects.toThrow(RecordNotFoundError);

    expect(await raw.unsafe(`SELECT * FROM "Note"`)).toHaveLength(0);
  });

  /** The same connect against our own folder still works. */
  test("a nested connect to a visible row is unaffected", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );

    await Model.asUser(OURS, () =>
      Note.$exec("create", {
        data: { label: "n", folder: { connect: { code: "ours" } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect(notes[0].folderId).toBe(2);
    expect(notes[0].orgId).toBe(7);
  });

  /** `asSystem` suspends both, as it does everywhere else. */
  test("asSystem reaches across tenants, deliberately", async () => {
    await Model.asSystem(() =>
      Note.$exec("create", {
        data: { label: "n", folder: { connect: { code: "theirs" } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect(notes[0].folderId).toBe(1);
  });
});
