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
  static $policies = [tenant()];
}

class Note extends Model {
  static $schema = noteSchema;
  static $policies = [tenant()];
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
   * The same rule for `createMany`, and it is the one that would be easiest to
   * lose: the children go through *one* `$exec` rather than one per row, so a
   * policy applied per statement instead of per row would leave every row after
   * the first belonging to nobody.
   *
   * `createMany` is in the set an `onCreate` applies to, and `withCreated` maps
   * it over the array — this asserts that end to end rather than trusting it.
   */
  test("a nested createMany carries the child's onCreate onto every row", async () => {
    await Model.asUser(OURS, () =>
      Folder.$exec("create", {
        data: {
          code: "ours",
          notes: {
            createMany: { data: [{ label: "a" }, { label: "b" }, { label: "c" }] },
          },
        },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT * FROM "Note" ORDER BY "id"`);
    expect(notes).toHaveLength(3);
    // Every one of them, not just the first.
    expect([...notes].map((note: any) => note.orgId)).toEqual([7, 7, 7]);
    // ...and they are all attached to the folder that was just written.
    expect(new Set([...notes].map((note: any) => note.folderId)).size).toBe(1);
  });

  /**
   * Whether the ORM refuses a misconfigured child policy must not depend on how
   * many rows the caller happened to pass.
   *
   * `Note` here carries a `scope` with no `onCreate`, which `assertCreateCovered`
   * refuses — an author who said "these rows belong to a tenant" without saying
   * which tenant a new row joins. A short-circuit on the empty list would skip
   * the child's `$exec`, and with it that check, so the same call would raise
   * with one row and succeed with none: the misconfiguration hides behind data
   * that happens to be empty in development and reports itself on the first
   * request whose list is not.
   *
   * Nothing is written either way, so this is not a leak — it is a refusal
   * arriving late, which is what deciding everything from the argument *shape*
   * exists to prevent.
   */
  test("an empty createMany refuses a bad child policy just as a full one does", async () => {
    const previous = (Note as any).$policies;
    (Note as any).$policies = [{ scope: () => ({ orgId: 7 }) } as ModelPolicy];

    try {
      const withRows = Model.asUser(OURS, () =>
        Folder.$exec("create", {
          data: { code: "a", notes: { createMany: { data: [{ label: "n" }] } } },
        }),
      );
      await expect(withRows).rejects.toThrow(/onCreate/);

      const withNone = Model.asUser(OURS, () =>
        Folder.$exec("create", {
          data: { code: "b", notes: { createMany: { data: [] } } },
        }),
      );
      await expect(withNone).rejects.toThrow(/onCreate/);

      // ...and neither wrote a folder, since the refusal rolls the parent back.
      expect(await raw.unsafe(`SELECT * FROM "Folder" WHERE "code" != 'theirs'`))
        .toHaveLength(0);
    } finally {
      (Note as any).$policies = previous;
    }
  });

  /**
   * A row that names the foreign key itself is describing a different parent
   * than the call is. The nested `create` beside it has always overridden it;
   * `createMany` does the same, and this pins that a caller cannot use it to
   * attach rows to somebody else's parent.
   */
  test("a nested createMany row cannot choose its own parent", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );

    await Model.asUser(OURS, () =>
      Folder.$exec("create", {
        data: {
          code: "fresh",
          notes: { createMany: { data: [{ label: "a", folderId: 1 }] } },
        },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect(notes).toHaveLength(1);
    // Not folder 1, which belongs to org 99.
    expect(notes[0].folderId).not.toBe(1);
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

  /**
   * `connectOrCreate` against a row this caller cannot see.
   *
   * The interesting part is that it must not raise. A scoped-away hit reads as
   * a **miss**, so the call takes the create branch and writes its own row —
   * which is the same answer the caller would get if the row genuinely did not
   * exist, and is what stops `connectOrCreate` from being a way to *probe* for
   * another tenant's keys: `connect` raising and `connectOrCreate` succeeding
   * would together tell you the row is there.
   *
   * The created row then carries our own tenant, because the child's `onCreate`
   * scopes it.
   */
  test("connectOrCreate cannot see another tenant's row, and creates instead", async () => {
    await Model.asUser(OURS, () =>
      Note.$exec("create", {
        data: {
          label: "n",
          folder: {
            connectOrCreate: {
              where: { code: "theirs" },
              create: { code: "theirs-mine" },
            },
          },
        },
      }),
    );

    const folders: any = await raw.unsafe(
      `SELECT "code", "orgId" FROM "Folder" ORDER BY "id"`,
    );

    // The other tenant's row is untouched, and ours was created beside it.
    expect(folders).toHaveLength(2);
    expect(folders[1].code).toBe("theirs-mine");
    expect(folders[1].orgId).toBe(7);
  });

  /** ...and a visible row is connected, not duplicated. */
  test("connectOrCreate connects a row this caller can see", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );

    await Model.asUser(OURS, () =>
      Note.$exec("create", {
        data: {
          label: "n",
          folder: {
            connectOrCreate: {
              where: { code: "ours" },
              create: { code: "ours" },
            },
          },
        },
      }),
    );

    const folders: any = await raw.unsafe(`SELECT * FROM "Folder"`);
    expect(folders).toHaveLength(2);

    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect(notes[0].folderId).toBe(2);
  });

  /**
   * `disconnect` reaches a row by unique key, so the child's scope is the only
   * thing standing between a caller and another tenant's row.
   *
   * The note below is linked to *our* folder — seeded that way deliberately —
   * but carries the other tenant's `orgId`. So the link is right and the policy
   * is what has to refuse: without the child's scope this clears a foreign key
   * on a row we cannot see, and reports success.
   */
  test("disconnect cannot clear a row the child's policy hides", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (10, 2, 'theirs', 99)`,
    );

    await Model.asUser(OURS, () =>
      Folder.$exec("update", {
        where: { id: 2 },
        // `code` is here only to satisfy "at least one field must be
        // updated": `Folder` has no `@updatedAt`, so a relation-only update has
        // no scalar assignment and is refused on this branch. #83 makes that
        // compile to a select of the same returning list; until it lands, a
        // no-op assignment keeps the test about the disconnect.
        data: { code: "ours", notes: { disconnect: { id: 10 } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT "folderId" FROM "Note"`);
    expect(notes[0].folderId).toBe(2);
  });

  /** ...and a visible one is cleared. */
  test("disconnect clears a row the caller can see", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (11, 2, 'ours', 7)`,
    );

    await Model.asUser(OURS, () =>
      Folder.$exec("update", {
        where: { id: 2 },
        // `code` is here only to satisfy "at least one field must be
        // updated": `Folder` has no `@updatedAt`, so a relation-only update has
        // no scalar assignment and is refused on this branch. #83 makes that
        // compile to a select of the same returning list; until it lands, a
        // no-op assignment keeps the test about the disconnect.
        data: { code: "ours", notes: { disconnect: { id: 11 } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT "folderId" FROM "Note"`);
    expect(notes[0].folderId).toBeNull();
  });

  /**
   * `delete` reports a hidden row as **not connected** rather than as denied,
   * which is the conservative answer: it is the same thing the caller would be
   * told about a row that genuinely belongs to another parent, so the two are
   * indistinguishable and neither confirms the row exists.
   */
  test("delete reports a hidden row as not connected, and leaves it", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (12, 2, 'theirs', 99)`,
    );

    await expect(
      Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { code: "ours", notes: { delete: { id: 12 } } },
        }),
      ),
    ).rejects.toThrow(/is not connected/);

    expect(await raw.unsafe(`SELECT * FROM "Note"`)).toHaveLength(1);
  });

  /**
   * A scoped model could not upsert at all: `assertScopable` refuses to put a
   * scope on one, because its where becomes an `on conflict` target and a
   * target cannot carry a predicate.
   *
   * That reason is exactly true of the `on conflict` path and **false** of the
   * read-then-write path, which is three ordinary statements. So the shape that
   * takes the second path — a `create` that leaves the conflict key unset — now
   * works, and is scoped by each of the three `$exec` calls it becomes.
   *
   * Recorded here rather than with the other upsert tests because the point is
   * the *policy*: a refusal whose justification had expired.
   */
  test("a scoped model can upsert through the read-then-write path", async () => {
    // `create` omits `id`, which is the conflict key the `where` names — the
    // shape `on conflict` cannot express and this path handles.
    const created: any = await Model.asUser(OURS, () =>
      Folder.$exec("upsert", {
        where: { id: 999_999 },
        create: { code: "made" },
        update: { code: "unused" },
      }),
    );

    expect(created.orgId).toBe(7);

    // And the read half is scoped, which is the half that matters: folder 1
    // belongs to org 99, so our user does not find it and creates instead of
    // updating somebody else's row.
    const second: any = await Model.asUser(OURS, () =>
      Folder.$exec("upsert", {
        where: { id: 1 },
        create: { code: "ours-not-theirs" },
        update: { code: "hijacked" },
      }),
    );

    expect(second.orgId).toBe(7);
    const theirs: any = await raw.unsafe(
      `SELECT * FROM "Folder" WHERE "id" = 1`,
    );
    expect(theirs[0].code).toBe("theirs");
    expect(theirs[0].orgId).toBe(99);
  });

  /** The `on conflict` shape still refuses, and its reason still holds. */
  test("a scoped model still cannot upsert through on conflict", async () => {
    await expect(
      Model.asUser(OURS, () =>
        Folder.$exec("upsert", {
          where: { code: "ours" },
          create: { code: "ours" },
          update: { code: "ours" },
        }),
      ),
    ).rejects.toThrow(/'on conflict' target/);
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

/**
 * Atomicity of a multi-statement write, which is what makes the policies above
 * mean anything on the write side.
 *
 * A nested write runs the *child's* `$exec`, so the child's policies are
 * consulted mid-sequence — after the parent row has already been inserted. When
 * the child denies, "your policy stopped the write" has to mean the whole write,
 * not the half that ran before the hook was reached. `$exec` therefore opens a
 * transaction for exactly the calls that are multi-statement, which it can tell
 * from the compiled plan's `before`/`after` steps.
 *
 * Deliberately observed through the raw connection rather than through the ORM:
 * a scoped read would hide a leftover row belonging to another tenant, which is
 * the very thing being checked for.
 */
describe("a denied nested write leaves nothing behind", () => {
  let workspace: string;
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-atomic-"));
    const url = `sqlite://${join(workspace, "atomic.db")}`;

    database = new DatabaseManager({ url });
    raw = new SQL(url);
    for (const statement of DDL) await raw.unsafe(statement);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);
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
  });

  test("the parent insert is rolled back when the child's policy denies", async () => {
    class OpenFolder extends Model {
      static $schema = folderSchema;
    }
    class RefusingNote extends Model {
      static $schema = noteSchema;
      static $policies = [{ before: () => false }];
    }
    register("Folder", OpenFolder);
    register("Note", RefusingNote);

    await expect(
      Model.asUser(OURS, () =>
        OpenFolder.$exec("create", {
          data: { code: "ours", notes: { create: { label: "n" } } },
        }),
      ),
    ).rejects.toThrow();

    // The parent was written before the nested step ran, so this is the
    // assertion that the transaction is real.
    const folders: any = await raw.unsafe(`SELECT * FROM "Folder"`);
    const notes: any = await raw.unsafe(`SELECT * FROM "Note"`);
    expect([...folders]).toHaveLength(0);
    expect([...notes]).toHaveLength(0);
  });

  test("a single-statement write still opens no transaction", async () => {
    class OpenFolder extends Model {
      static $schema = folderSchema;
    }
    register("Folder", OpenFolder);

    const statements: string[] = [];
    const counted = new Proxy(database, {
      get(target: any, key) {
        if (key !== "sql") return target[key];
        return new Proxy(target.sql, {
          get(sql: any, method) {
            if (method !== "unsafe") return sql[method];
            return (text: string, values?: unknown[]) => {
              statements.push(text);
              return sql.unsafe(text, values);
            };
          },
        });
      },
    });

    const proxied = new Application();
    proxied.instance(DatabaseManager, counted as never);

    // `finally`, and restoring the instance `beforeAll` built rather than a
    // fresh one. A throw here is precisely what a regression in the atomicity
    // change looks like, and leaving the counting proxy installed would surface
    // it as an unrelated failure in whatever test ran next.
    const before = Application.getInstance();
    try {
      Application.setInstance(proxied);
      await Model.asSystem(() =>
        OpenFolder.$exec("create", { data: { code: "plain" } }),
      );
    } finally {
      Application.setInstance(before!);
    }

    expect(statements.some((text) => /^\s*begin/i.test(text))).toBe(false);
    expect(statements).toHaveLength(1);
  });
});
