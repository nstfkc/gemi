import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  RecordNotFoundError,
  ScopeEscapeError,
  UniqueConstraintError,
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
  `DROP TABLE IF EXISTS "Cover"`,
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
  // The to-one half, and the `UNIQUE` is the whole point of it: a relation that
  // holds one row is a foreign key with a unique index on it, which is what
  // turns the `upsert` case below into a collision rather than a second row.
  `CREATE TABLE "Cover" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "folderId" INTEGER UNIQUE,
     "caption" TEXT NOT NULL,
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
    /**
     * The **to-one whose key is on the child** — the shape #354 implemented,
     * and the one this harness could not otherwise reach: every relation above
     * that a policy can hide is a list, so a hidden row is always a *narrowing*
     * of a set the caller named. Here the caller names nothing, so hiding the
     * one row is the whole operand.
     *
     * Copied from the generated shape rather than guessed — `User.profile` in
     * `app/models/generated/schema.ts` is exactly
     * `{ kind: "one", from: [], to: [], nullable: true }`, and `from` being
     * empty is what routes this to `planForeignSide`.
     */
    cover: {
      name: "cover",
      model: "Cover",
      kind: "one",
      relationName: "CoverToFolder",
      from: [],
      to: [],
      nullable: true,
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

const coverSchema: ModelSchema = {
  name: "Cover",
  table: "Cover",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    folderId: field("folderId", "Int", { nullable: true }),
    caption: field("caption", "String"),
    orgId: field("orgId", "Int", { nullable: true }),
  },
  primaryKey: ["id"],
  // The foreign key is the unique one, which is what makes the relation hold a
  // single row — `Profile.userId @unique` in the template's schema.
  uniques: [["folderId"]],
  relations: {
    folder: {
      name: "folder",
      model: "Folder",
      kind: "one",
      relationName: "CoverToFolder",
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

class Cover extends Model {
  static $schema = coverSchema;
  static $policies = [tenant()];
}

/** The same model with no policy at all, for the parity half of `set`. */
class Unpolicied extends Model {
  static $schema = noteSchema;
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
    register("Cover", Cover);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Cover"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Note"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Folder"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`DELETE FROM "Cover"`);
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
   * A child whose policy scopes on its **own foreign key** — `{ folderId: … }`,
   * a plausible "my notes" scope — and which declares no `onUpdate` (#98).
   *
   * `connect` writes exactly that column, so `assertNoScopeEscape` used to
   * refuse it: the guard reads `args.data` and could not tell a column the
   * caller supplied from one the nested step put there. The caller wrote
   * `connect: { id }`; `folderId` was in `data` because the ORM chose it.
   *
   * The row is still only reachable through the child's own scope — that is a
   * different mechanism and it is untouched, which the second test pins.
   */
  test("a foreign-key scope no longer refuses a nested connect", async () => {
    class KeyScoped extends Model {
      static $schema = noteSchema;
      static $policies = [{ scope: () => ({ folderId: 2 }) } as ModelPolicy];
    }
    register("Note", KeyScoped);

    try {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (20, 2, 'ours', 7)`,
      );

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { code: "ours", notes: { connect: { id: 20 } } },
        }),
      );

      const notes: any = await raw.unsafe(`SELECT "folderId" FROM "Note"`);
      expect(notes[0].folderId).toBe(2);
    } finally {
      register("Note", Note);
    }
  });

  /**
   * The half that must not move: a **caller** naming the scoped column in
   * `data` is still refused. The marker lists the columns the ORM wrote, so
   * anything else in the payload is judged exactly as before.
   */
  test("a caller naming the scoped column is still refused", async () => {
    class KeyScoped extends Model {
      static $schema = noteSchema;
      static $policies = [{ scope: () => ({ folderId: 2 }) } as ModelPolicy];
    }
    register("Note", KeyScoped);

    try {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (21, 2, 'ours', 7)`,
      );

      await expect(
        Model.asUser(OURS, () =>
          KeyScoped.$exec("update", {
            where: { id: 21 },
            data: { folderId: 9 },
          }),
        ),
      ).rejects.toThrow(ScopeEscapeError);
    } finally {
      register("Note", Note);
    }
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
   *
   * **`data` carries no scalar assignment, and that used to be impossible.**
   * Both of these tests used to set `code` to the value it already had, with a
   * note saying a relation-only `update` was refused for having nothing to
   * `SET` and that #83 would make it compile to a select. #83 landed (`Writes
   * through an implicit many-to-many join table`), and an empty `data` now
   * takes the same select — so the no-op assignment is gone from both, which is
   * what the note said should happen to it. It is worth removing rather than
   * leaving: a stray `code: "ours"` reads as part of what is being tested, and
   * it is the difference between this call emitting an `UPDATE` and emitting
   * the `SELECT` a caller would really get.
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
        data: { notes: { disconnect: { id: 10 } } },
      }),
    );

    const notes: any = await raw.unsafe(`SELECT "folderId" FROM "Note"`);
    expect(notes[0].folderId).toBe(2);
  });

  /** ...and a visible one is cleared. Relation-only `data`, as above. */
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
        data: { notes: { disconnect: { id: 11 } } },
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
   * The claim `update` is implemented on: **the child's own `$exec` already
   * carries the pass the refusal said was missing.**
   *
   * `REFUSED` used to say a nested `update` "needs its own scoping pass" for
   * `onUpdate` and the scope-escape guard. Both live in `applyPolicies`, which
   * runs because the step is not pre-scoped — so the pass was never missing,
   * it was one layer down. These two assert that, from the outside.
   */
  test("a nested update is scoped by the child, not by the caller", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    // Linked to our folder, but owned by the other tenant.
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (30, 2, 'theirs', 99)`,
    );

    await expect(
      Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: {
            code: "ours",
            notes: { update: { where: { id: 30 }, data: { label: "hacked" } } },
          },
        }),
      ),
    ).rejects.toThrow(RecordNotFoundError);

    const notes: any = await raw.unsafe(`SELECT "label" FROM "Note"`);
    expect(notes[0].label).toBe("theirs");
  });

  /**
   * ...and the payload is judged by the child too: naming a column the child's
   * policy scopes on is refused, exactly as it would be at the top level. The
   * caller wrote this one, so #98's provenance exemption does not apply — which
   * is the distinction that makes both tests worth having.
   */
  test("a nested update cannot write the child's scoped column", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (31, 2, 'ours', 7)`,
    );

    await expect(
      Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: {
            code: "ours",
            notes: { update: { where: { id: 31 }, data: { orgId: 99 } } },
          },
        }),
      ),
    ).rejects.toThrow(ScopeEscapeError);

    const notes: any = await raw.unsafe(`SELECT "orgId" FROM "Note"`);
    expect(notes[0].orgId).toBe(7);
  });

  /**
   * **A to-one whose key is on the child**, now that `update`, `delete` and
   * `upsert` are implemented there.
   *
   * The normalisation that implemented them rewrites the operand's *shape* and
   * nothing else — `delete: true` becomes `{}`, `false` becomes `null`, a bare
   * `update` payload becomes `{ where, data }` — and then falls through to the
   * same bodies the to-many uses. Read rather than assumed: every `executor.exec`
   * on that path still passes `false` for pre-scoping, so the child's `$exec`
   * runs its own policies exactly as it does for a list. The scope, the
   * `onCreate`/`onUpdate` hooks and the scope-escape guard therefore need no
   * to-one cases — they are the same calls, and the tests above already own
   * them.
   *
   * **One thing is genuinely different, and it changes the answer's kind.** On a
   * to-many the caller names the rows, so a row the child's policy hides is a
   * *narrowing*: `disconnect: { id: 10 }` above quietly acts on nothing and the
   * other operands still have the rows that were visible. On a to-one the caller
   * names no row at all — `delete: true` means "the connected one" — so hiding
   * that row does not narrow the operand, it empties it. The lookup misses, and
   * a miss is the whole operand.
   *
   * Which matters because Prisma answers a to-one miss with P2025 rather than
   * with silence. So a policy can turn a to-one nested write into an error where
   * the same policy on a list turned it into a no-op.
   */
  describe("a to-one whose key is on the child", () => {
    /** Ours; the cover seeded against it is the other tenant's. */
    const seedFolder = () =>
      raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );

    const hiddenCover = () =>
      raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (50, 2, 'theirs', 99)`,
      );

    /**
     * `delete: true` against a child the policy hides answers **exactly what it
     * answers when there is no child at all**, and both assertions are here
     * together because the point is that they are indistinguishable.
     *
     * That is the same conservative direction the to-many `delete` takes one
     * screen up — a hidden row reports as not connected rather than as denied —
     * arrived at through a different route. There the reason is that the row the
     * caller named cannot be found among this parent's children; here the caller
     * named nothing, so what cannot be found is the relation's single row. The
     * error is `RecordNotFoundError` rather than the to-many's "is not
     * connected", because on a to-one there is no name to quote back and because
     * Prisma answers P2025.
     *
     * Reading it the other way round is what makes it worth pinning: a caller
     * who can see a folder but not its cover is told the folder has no cover.
     * They cannot tell a folder whose cover belongs to another tenant from one
     * that has none, which is the property that stops the operand being a probe.
     */
    test("delete: true reads a hidden child as no child at all", async () => {
      await seedFolder();
      await hiddenCover();
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (3, 'bare', 7)`,
      );

      const hidden = Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { cover: { delete: true } },
        }),
      );
      await expect(hidden).rejects.toThrow(RecordNotFoundError);

      // Folder 3 genuinely has no cover, and says the same thing.
      const absent = Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 3 },
          data: { cover: { delete: true } },
        }),
      );
      await expect(absent).rejects.toThrow(RecordNotFoundError);

      // Observed raw, because a scoped read could not see the row either way.
      const covers: any = await raw.unsafe(`SELECT * FROM "Cover"`);
      expect([...covers]).toHaveLength(1);
      expect(covers[0].orgId).toBe(99);
    });

    /**
     * The non-vacuity half: the same call against a visible child deletes it. A
     * `delete: true` that raised for some reason of its own — the operand not
     * reaching the child at all, say — would pass the test above for the wrong
     * reason.
     */
    test("delete: true deletes a child the caller can see", async () => {
      await seedFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (51, 2, 'ours', 7)`,
      );

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { cover: { delete: true } },
        }),
      );

      expect(await raw.unsafe(`SELECT * FROM "Cover"`)).toHaveLength(0);
    });

    /**
     * ...and `disconnect: true` against the *same* hidden child is silent.
     *
     * The two operands share one body and differ only in whether a miss is
     * fatal — Prisma's asymmetry, measured, not a choice made here. This asserts
     * that the asymmetry survives a miss the *policy* caused rather than the
     * data: a scoped-away child produces the same silence a genuinely absent one
     * does, and does not acquire `delete`'s error by sharing its code path.
     */
    test("disconnect: true is silent about the same hidden child", async () => {
      await seedFolder();
      await hiddenCover();

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { disconnect: true } },
          }),
        ),
      ).resolves.toBeDefined();

      const covers: any = await raw.unsafe(`SELECT "folderId" FROM "Cover"`);
      expect(covers[0].folderId).toBe(2);
    });

    /**
     * **The one that could genuinely surprise somebody.**
     *
     * A nested `upsert` decides its branch with a lookup, and the lookup runs
     * through the child's own `$exec` — so a child the policy hides reads as a
     * miss, and the miss takes the **create** branch. The create then stamps the
     * parent's key into the child's foreign key, which on a to-one carries a
     * unique index. It collides with the row the caller was not allowed to see.
     *
     * This is the to-one reading of a note already in `planForeignSide`: an
     * upsert aimed at a row belonging to *another parent* takes the create
     * branch and collides, and Prisma does the same, measured — `where` matching
     * nothing with a child present gives P2002, *"Unique constraint failed on
     * the fields: (`userId`)"*. What the implementation's comment does not
     * predict is that a **policy** reaches the same place: the child is this
     * parent's, the relation is right, and the reason the lookup misses is that
     * this caller may not see the row.
     *
     * So the error a caller gets is `UniqueConstraintError` naming a field they
     * never wrote. It does not leak the row's contents, and it is the same
     * answer they would get from a genuine key collision — but it is a
     * *different* answer from the one `delete` gives one test up, and that is
     * worth having written down: the two hidden-child cases are not uniform, and
     * only `delete` and `update` reduce to "no such row".
     *
     * Nothing is written either way, which is the part that has to hold.
     */
    test("an upsert whose child is hidden collides on the child's unique key", async () => {
      await seedFolder();
      await hiddenCover();

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: {
              cover: {
                upsert: {
                  create: { caption: "mine" },
                  update: { caption: "updated" },
                },
              },
            },
          }),
        ),
      ).rejects.toThrow(UniqueConstraintError);

      // The other tenant's row is still there, still theirs, still unedited —
      // and no second row was written beside it.
      const covers: any = await raw.unsafe(`SELECT * FROM "Cover"`);
      expect([...covers]).toHaveLength(1);
      expect(covers[0].caption).toBe("theirs");
      expect(covers[0].orgId).toBe(99);
    });

    /**
     * Both branches against rows the caller *can* see, which is what says the
     * test above is about the policy rather than about the upsert.
     *
     * The create half also pins that the child's `onCreate` runs on this path:
     * the row it writes carries our tenant, and its foreign key comes from the
     * parent rather than from the payload.
     */
    test("an upsert takes its branches normally when nothing is hidden", async () => {
      await seedFolder();

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: {
            cover: {
              upsert: {
                create: { caption: "made" },
                update: { caption: "unused" },
              },
            },
          },
        }),
      );

      let covers: any = await raw.unsafe(`SELECT * FROM "Cover"`);
      expect([...covers]).toHaveLength(1);
      expect(covers[0].caption).toBe("made");
      expect(covers[0].folderId).toBe(2);
      // The child's `onCreate`, through its own `$exec`.
      expect(covers[0].orgId).toBe(7);

      // Now that one exists and is visible, the same call updates it.
      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: {
            cover: {
              upsert: {
                create: { caption: "unused" },
                update: { caption: "updated" },
              },
            },
          },
        }),
      );

      covers = await raw.unsafe(`SELECT * FROM "Cover"`);
      expect([...covers]).toHaveLength(1);
      expect(covers[0].caption).toBe("updated");
    });

    /**
     * The remaining to-one operand with a policy answer of its own: a nested
     * `update` naming no row. It reduces to "no such row" like `delete`, so it
     * is one assertion rather than a pair — but it is the operand a ported
     * application reaches for most, and the scoped miss is what it gets.
     */
    test("update on a hidden child is a miss, and writes nothing", async () => {
      await seedFolder();
      await hiddenCover();

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { update: { caption: "hacked" } } },
          }),
        ),
      ).rejects.toThrow(RecordNotFoundError);

      const covers: any = await raw.unsafe(`SELECT "caption" FROM "Cover"`);
      expect(covers[0].caption).toBe("theirs");
    });

    /**
     * A nested `create` **displaces** the child that is already linked (#360),
     * and the displaced row is orphaned rather than deleted — Prisma's answer,
     * measured, and the half of it that would be silent data loss to get wrong.
     *
     * Here for the policy that decides *which* incumbent it can displace: the
     * clearing read goes through the child's own `findMany`, so this is `set`'s
     * rule reached by a different operand.
     */
    test("create displaces the linked child the caller can see, orphaning it", async () => {
      await seedFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (52, 2, 'ours', 7)`,
      );

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { cover: { create: { caption: "second" } } },
        }),
      );

      const covers: any = await raw.unsafe(
        `SELECT "caption", "folderId", "orgId" FROM "Cover" ORDER BY "id"`,
      );
      // Two rows: the incumbent survives with no link, the new one takes it.
      expect([...covers].map((cover: any) => [cover.caption, cover.folderId])).toEqual([
        ["ours", null],
        ["second", 2],
      ]);
      // And the new row is ours, through the child's own `onCreate`.
      expect(covers[1].orgId).toBe(7);
    });

    /**
     * ...and the incumbent this caller **cannot see** is not displaced.
     *
     * The clearing read misses, so nothing is detached, and the insert then
     * collides with the row the caller was never shown — `UniqueConstraintError`
     * naming a column they did not write. That is the same answer the hidden
     * `upsert` gives two tests up, and it is the conservative one: the
     * alternative is detaching another tenant's row on a call that never named
     * it, which is exactly what `set`'s lookup exists to prevent.
     *
     * The unhappy reading is worth stating plainly, because it is the cost:
     * this caller cannot complete the write at all, and the error does not say
     * why. Nothing is written either way, which is the part that has to hold.
     */
    test("create does not displace an incumbent the caller cannot see", async () => {
      await seedFolder();
      await hiddenCover();

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { create: { caption: "second" } } },
          }),
        ),
      ).rejects.toThrow(UniqueConstraintError);

      // Theirs, still linked, still unedited — and no second row beside it.
      const covers: any = await raw.unsafe(`SELECT * FROM "Cover"`);
      expect([...covers]).toHaveLength(1);
      expect(covers[0].caption).toBe("theirs");
      expect(covers[0].folderId).toBe(2);
    });

    /**
     * `connect` displaces the same way `create` does (#361) and through the
     * same `clearLinks`, so it inherits the same rule — asserted rather than
     * assumed, because the two reach it by different routes: `create` writes a
     * new row and `connect` repoints an existing one, and only the clear is
     * shared.
     *
     * Both halves in one test, because the pair is the point: the loose cover
     * this caller *can* see takes the link and our incumbent is orphaned; run
     * against a hidden incumbent instead, nothing is detached and the repoint
     * collides with the row the caller was never shown.
     */
    test("connect displaces a visible incumbent and not a hidden one", async () => {
      await seedFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (53, 2, 'ours', 7), (54, NULL, 'loose', 7)`,
      );

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { cover: { connect: { id: 54 } } },
        }),
      );

      let covers: any = await raw.unsafe(
        `SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`,
      );
      expect([...covers].map((cover: any) => [cover.id, cover.folderId])).toEqual([
        [53, null],
        [54, 2],
      ]);

      // Now the incumbent is the other tenant's. Same call, same loose row.
      await raw.unsafe(`DELETE FROM "Cover"`);
      await hiddenCover();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (55, NULL, 'loose', 7)`,
      );

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { connect: { id: 55 } } },
          }),
        ),
      ).rejects.toThrow(UniqueConstraintError);

      covers = await raw.unsafe(`SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`);
      expect([...covers].map((cover: any) => [cover.id, cover.folderId])).toEqual([
        [50, 2],
        [55, null],
      ]);
    });

    /**
     * **`connect` naming the row that is already linked here, under a child
     * scoped on its own foreign key** — #372, and the case #361's displacement
     * broke without any test being able to see it.
     *
     * `M15b` pins this call in the differential and stays green either way,
     * because it reads the *table*: `clearLinks` nulled the named row and the
     * repoint put the key straight back, so the committed state agreed with
     * Prisma's. What it could not see is that the two statements contradict each
     * other the moment a policy scopes on the column they both write. The clear
     * moves the row out of `{ folderId: 2 }`; the repoint has to select it *by*
     * `{ folderId: 2 }`; so the repoint matched nothing and the call raised
     * `RecordNotFoundError: No Cover found (Cover.update)` — a model and an
     * operation the caller never wrote, on a call that worked before #361.
     *
     * The fix resolves the named row first and short-circuits, which is also
     * what Prisma does — the same call on a generated 6.19.2 client logs four
     * selects and no `UPDATE`. So the assertion is that this succeeds and the
     * link survives, which is what this call answers when the operand is
     * `{ id: 56 }` and no policy is registered.
     *
     * **The scope is one way to reach the crossing, not the only one.** The
     * repoint fails whenever anything in its `where` depends on the value the
     * clear just nulled, and a caller who spells the operand as
     * `connect: { folderId: 2 }` supplies that himself — no policy needed.
     * That shape is pinned in the differential as `M15e`, where it shows up as
     * `error` against `ok`; this file cannot host it, because it is
     * SQLite-only by construction (its `beforeAll` builds its own `sqlite://`
     * workspace, so the Postgres job never reaches these three tests).
     *
     * Read this next to `"a foreign-key scope allows relation operands the ORM
     * keyed"` further down, which is the same scope on the to-many side and
     * where `set` is still refused: the two answers are different because
     * `set`'s *link* half deliberately does not name its column as ORM-authored,
     * so it is stopped by the guard before it can reach the scope. `connect`
     * passes the guard (#98) and used to fail on the scope instead.
     */
    test("connect of the row already linked here survives a key scope", async () => {
      class KeyScoped extends Model {
        static $schema = coverSchema;
        static $policies = [{ scope: () => ({ folderId: 2 }) } as ModelPolicy];
      }
      register("Cover", KeyScoped);

      try {
        await seedFolder();
        await raw.unsafe(
          `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
            `VALUES (56, 2, 'already', 7)`,
        );

        await Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { connect: { id: 56 } } },
          }),
        );

        const covers: any = await raw.unsafe(
          `SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`,
        );
        expect([...covers].map((cover: any) => [cover.id, cover.folderId])).toEqual([
          [56, 2],
        ]);
      } finally {
        register("Cover", Cover);
      }
    });

    /**
     * **The same call spelled two ways has to give one answer** (#373).
     *
     * `connectOrCreate`'s hit branch repoints through the very `update` the
     * bare `connect` uses — the neighbouring branch of `planForeignSide` — and
     * used not to name `folderId` as the ORM's. Under a child scoped on its own
     * foreign key that split the two apart, the operand that carries a fallback
     * it does not take raising about a write the caller never made:
     *
     *     connect          resolved
     *     connectOrCreate  ScopeEscapeError: Cover.update writes 'folderId', …
     *
     * **The scope is `{ in: [2, 3] }` rather than the bare `{ folderId: 2 }` an
     * earlier draft used, and the widening is what makes the test mean
     * anything.** Under `{ folderId: 2 }` the only cover this policy can see is
     * one already pointing at folder 2 — so the only reachable `connect` is of
     * the row already linked, and *that* case is decided before the repoint is
     * reached (by `clearLinks` on the way in, and now by the hit branch's
     * already-linked short-circuit). The marked `update` this issue is about
     * never ran, and the whole assertion turned on which way two unrelated
     * refusals happened to fall. A scope that admits two folders lets a cover be
     * *visible on folder 3 and repointed to folder 2*, which is a real repoint
     * through the guard, with both spellings resolving.
     *
     * It also makes the pin **independent of #372/#379**: neither spelling is
     * already linked here, so an already-linked short-circuit on either side
     * cannot pull the two apart. The equality is asserted against a literal as
     * well — `"resolved"` — so a future change that made *both* raise would be
     * caught rather than agreed with.
     *
     * The `set` refusal in *"a foreign-key scope allows relation operands the
     * ORM keyed"* below is the deliberate counter-example: its link half is
     * *not* named as the ORM's, so it is still refused. That is a choice about
     * a half-write, not an oversight — see the comment there.
     */
    test("connectOrCreate's hit branch answers exactly as connect does", async () => {
      class KeyScoped extends Model {
        static $schema = coverSchema;
        static $policies = [
          { scope: () => ({ folderId: { in: [2, 3] } }) } as ModelPolicy,
        ];
      }
      register("Cover", KeyScoped);

      try {
        await seedFolder();
        // The second folder the scope admits, so a visible cover can start off
        // somewhere other than where it is being connected.
        await raw.unsafe(
          `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (3, 'spare', 7)`,
        );

        const park = async () => {
          await raw.unsafe(`DELETE FROM "Cover"`);
          await raw.unsafe(
            `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
              `VALUES (56, 3, 'parked', 7)`,
          );
        };

        const outcome = async (operand: unknown) => {
          try {
            await Model.asUser(OURS, () =>
              Folder.$exec("update", {
                where: { id: 2 },
                data: { code: "ours", cover: operand },
              }),
            );
            return "resolved";
          } catch (error) {
            return (error as Error).constructor.name;
          }
        };

        const table = async () => {
          const rows: any = await raw.unsafe(
            `SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`,
          );
          return [...rows].map((cover: any) => [cover.id, cover.folderId]);
        };

        await park();
        const bare = await outcome({ connect: { id: 56 } });
        const after = await table();

        await park();
        const paired = await outcome({
          connectOrCreate: { where: { id: 56 }, create: { caption: "made" } },
        });

        expect(bare).toBe("resolved");
        expect(paired).toBe(bare);
        // The table too, and not only the verdict: the two could agree on
        // "resolved" while one of them wrote something the other did not.
        expect(await table()).toEqual(after);
        // ...and the non-vacuity, which is *this* line and not the count: the
        // cover really moved off folder 3, so the marked `update` ran rather
        // than the operand falling through to its create branch.
        expect(after).toEqual([[56, 2]]);

        /**
         * **The hit branch on the row already linked here writes nothing.**
         *
         * Cover 56 now points at folder 2, so this is the case the paragraph
         * above says `{ folderId: 2 }` could only ever reach. Without the
         * short-circuit the branch clears the link and then repoints the row it
         * just nulled — and a null `folderId` is outside `{ in: [2, 3] }`, so
         * the repoint cannot select it back and the operand raises
         * `RecordNotFoundError` on a call that should change nothing.
         *
         * The bare `connect` still does exactly that (#372), which is why this
         * asserts the hit branch alone rather than another equality: the two
         * spellings are *allowed* to differ here until #372 lands, and pinning
         * their agreement would go red the moment it does.
         */
        const again = await outcome({
          connectOrCreate: { where: { id: 56 }, create: { caption: "made" } },
        });
        expect(again).toBe("resolved");
        expect(await table()).toEqual([[56, 2]]);
      } finally {
        register("Cover", Cover);
      }
    });

    /**
     * ...and it succeeds by **writing nothing**, which is the half the table
     * cannot show and the half that fixes the case above.
     *
     * Two repairs reach the assertion in the test before this one. Excluding the
     * named row from the clear leaves the repoint in place, writing the value
     * that is already there; short-circuiting the whole operand issues neither.
     * Both leave `[[56, 2]]` behind, and only the second is what Prisma does —
     * measured on 6.19.2/SQLite with `log: [{ emit: "event", level: "query" }]`,
     * the call is `BEGIN IMMEDIATE`, four selects, `COMMIT`, with no `UPDATE`
     * anywhere in it, where the same `connect` onto an *occupied* folder logs
     * the incumbent clear and the repoint.
     *
     * The difference is reachable rather than theoretical: a child carrying
     * `@updatedAt` would have its stamp bumped by the repoint on a call Prisma
     * does not write at all. `Cover` has no such column — which is why this is
     * asserted on the writes rather than on the row.
     *
     * **Counted through `onUpdate` rather than through the SQL**, which is not
     * merely convenient: every write to `Cover` on this path goes through
     * `Cover`'s own `$exec` and therefore through its policies, so a hook that
     * counts sees the clear's `updateMany` and the repoint's `update` alike —
     * `MUTATING` in `policy.ts` carries both. Intercepting statements would have
     * to reach inside the transaction the nested steps run in, where
     * `database.sql` is no longer the object issuing them.
     *
     * The occupied-folder call is in the same test as the control, so the
     * counter is shown to count before it is trusted to count zero.
     */
    test("that connect writes nothing, where an occupied folder writes twice", async () => {
      let updates = 0;
      class Counted extends Model {
        static $schema = coverSchema;
        static $policies = [
          {
            scope: (context: any) => ({ orgId: context.user.orgId }),
            onUpdate: (_context: any, data: any) => {
              updates++;
              return data;
            },
          } as ModelPolicy,
        ];
      }
      register("Cover", Counted);

      try {
        await seedFolder();
        await raw.unsafe(
          `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
            `VALUES (57, 2, 'already', 7)`,
        );

        await Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { connect: { id: 57 } } },
          }),
        );

        expect(updates).toBe(0);

        // The control: the same operand where the named row is *not* the one
        // linked here. Two writes — the incumbent's clear and the repoint — so
        // the zero above is a measurement rather than a hook that never fires.
        await raw.unsafe(
          `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
            `VALUES (58, NULL, 'loose', 7)`,
        );

        await Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { connect: { id: 58 } } },
          }),
        );

        expect(updates).toBe(2);
      } finally {
        register("Cover", Cover);
      }
    });

    /**
     * **The short-circuit is scoped, and getting that backwards is the expensive
     * mistake** — so it is pinned rather than left to the code comment.
     *
     * Cover 50 holds folder 2 and belongs to the other tenant. The lookup that
     * decides "already linked here" runs through `Cover`'s own `$exec`
     * un-pre-scoped, so this caller's policies apply and the row reads as
     * absent — the same rule the repoint beside it follows. The operand is
     * therefore *not* short-circuited, the clear finds nothing it may touch, and
     * the repoint raises.
     *
     * An unscoped lookup would answer "already linked" here and make the whole
     * `connect` a silent no-op: a call that reports success, links nothing, and
     * tells the caller a row they cannot see is theirs. That is strictly worse
     * than the miss, which is why the direction is asserted.
     */
    test("the no-op does not fire for a linked row the caller cannot see", async () => {
      await seedFolder();
      await hiddenCover();

      await expect(
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { cover: { connect: { id: 50 } } },
          }),
        ),
      ).rejects.toThrow(RecordNotFoundError);

      const covers: any = await raw.unsafe(
        `SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`,
      );
      expect([...covers].map((cover: any) => [cover.id, cover.folderId])).toEqual([
        [50, 2],
      ]);
    });
  });

  /**
   * The **owning** side of a to-one — `Note.folder`, where the key is on the
   * row being written (#359).
   *
   * The three arms do not consult the child equally, and that is the whole
   * content of this describe:
   *
   *   disconnect: true      no lookup at all — the column is on this row
   *   disconnect: false     no lookup, and no write either
   *   disconnect: <filter>  reads the linked row through *its own* `$exec`
   *
   * So the filter arm acquires a scoping question the boolean does not have,
   * and answers it the way every other lookup in this file does: a linked row
   * the caller cannot see reads as one that does not match, and the link
   * survives. `true` detaches it regardless, because there is nothing to read —
   * the caller is writing a column of a row they already hold.
   */
  describe("a to-one whose key is on this row", () => {
    /** Our note, pointing at the *other* tenant's folder. */
    const seedNote = () =>
      raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (60, 1, 'ours', 7)`,
      );

    const folderIdOf = async (id: number) => {
      const rows: any = await raw.unsafe(
        `SELECT "folderId" FROM "Note" WHERE "id" = ${id}`,
      );
      return rows[0].folderId;
    };

    test("a filter does not detach a linked row the caller cannot see", async () => {
      await seedNote();

      await expect(
        Model.asUser(OURS, () =>
          Note.$exec("update", {
            where: { id: 60 },
            // An empty filter, which is the *widest* one there is: it matches
            // every row, so the only thing that can make it miss is the scope.
            data: { folder: { disconnect: {} } },
          }),
        ),
      ).resolves.toBeDefined();

      expect(await folderIdOf(60)).toBe(1);
    });

    test("a filter detaches a linked row the caller can see", async () => {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (61, 2, 'ours', 7)`,
      );

      await Model.asUser(OURS, () =>
        Note.$exec("update", {
          where: { id: 61 },
          data: { folder: { disconnect: { code: "ours" } } },
        }),
      );

      expect(await folderIdOf(61)).toBeNull();
      // Detached, not deleted: the far row is nobody's business here.
      const folders: any = await raw.unsafe(`SELECT "id" FROM "Folder" WHERE "id" = 2`);
      expect([...folders]).toHaveLength(1);
    });

    /**
     * **`true` is not scoped, and that is deliberate rather than an oversight.**
     *
     * It writes one column of the row the statement already names, and that row
     * is this caller's — the parent's own policies decided that before the
     * statement ran. There is no read of the far model to scope, so hiding the
     * far row cannot be made to matter without inventing a lookup the operand
     * does not need. Prisma's `true` means "the connected row" and consults
     * nothing either.
     *
     * Pinned because the pair reads as an inconsistency otherwise: the same
     * operand, on the same relation, detaches under `true` and does not under
     * `{}` — with the difference being which model's rows the call touches.
     */
    test("true detaches whatever is linked, hidden or not", async () => {
      await seedNote();

      await Model.asUser(OURS, () =>
        Note.$exec("update", {
          where: { id: 60 },
          data: { folder: { disconnect: true } },
        }),
      );

      expect(await folderIdOf(60)).toBeNull();
    });

    /** And `false` writes nothing at all, hidden far row or not. */
    test("false leaves the link alone", async () => {
      await seedNote();

      await Model.asUser(OURS, () =>
        Note.$exec("update", {
          where: { id: 60 },
          data: { label: "renamed", folder: { disconnect: false } },
        }),
      );

      expect(await folderIdOf(60)).toBe(1);
      const notes: any = await raw.unsafe(`SELECT "label" FROM "Note" WHERE "id" = 60`);
      expect(notes[0].label).toBe("renamed");
    });

    /**
     * `upsert` on this side (#391), whose branch is decided by a lookup through
     * the far model's own `$exec` — so the scope decides the branch, exactly as
     * it does for the `disconnect` filter arm two tests up and for
     * `connectOrCreate` on the other side.
     *
     * **A linked row the caller cannot see reads as absent, so the create
     * branch runs and this row is repointed at the new one.** That is a
     * different answer from the foreign side's, where the same hidden row gives
     * `UniqueConstraintError`, and the difference is structural rather than a
     * choice: there the create stamps the parent's key into a column carrying a
     * unique index the hidden row is holding, and here the key being written is
     * this row's own, which nothing else constrains.
     *
     * What both answers have in common is the part that matters: the row the
     * caller may not see is **not written**. This one leaves it where it is and
     * stops pointing at it; it does not edit it, and it does not delete it.
     */
    // By `code` rather than by `id`: the table's autoincrement is not reset
    // between cases, so a minted row's id is whatever this file has reached.
    const folders = async () => {
      const rows: any = await raw.unsafe(
        `SELECT "code", "orgId" FROM "Folder" ORDER BY "id"`,
      );
      return [...rows].map((row: any) => [row.code, row.orgId]);
    };

    const folderIdBy = async (code: string) => {
      const rows: any = await raw.unsafe(
        `SELECT "id" FROM "Folder" WHERE "code" = '${code}'`,
      );
      return rows[0].id;
    };

    test("upsert creates and repoints rather than editing a hidden linked row", async () => {
      await seedNote();

      await Model.asUser(OURS, () =>
        Note.$exec("update", {
          where: { id: 60 },
          data: {
            folder: {
              upsert: { create: { code: "made" }, update: { code: "hacked" } },
            },
          },
        }),
      );

      // The other tenant's folder is untouched, and the new one carries our
      // tenant — the child's `onCreate`, through its own `$exec`.
      expect(await folders()).toEqual([
        ["theirs", 99],
        ["made", 7],
      ]);
      expect(await folderIdOf(60)).toBe(await folderIdBy("made"));
    });

    test("upsert updates a linked row the caller can see", async () => {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (61, 2, 'ours', 7)`,
      );

      await Model.asUser(OURS, () =>
        Note.$exec("update", {
          where: { id: 61 },
          data: {
            folder: {
              upsert: { create: { code: "unused" }, update: { code: "renamed" } },
            },
          },
        }),
      );

      // No third folder, and the link did not move.
      expect(await folders()).toEqual([
        ["theirs", 99],
        ["renamed", 7],
      ]);
      expect(await folderIdOf(61)).toBe(2);
    });

    /**
     * The payload goes through the far model's own `onUpdate` and its
     * scope-escape guard, because the branch runs as that model's `updateMany`
     * un-pre-scoped — the same rule a nested `update` follows. A caller naming
     * the scoped column is refused rather than moving the row out of its tenant.
     */
    test("upsert's update branch cannot write the far model's scoped column", async () => {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (61, 2, 'ours', 7)`,
      );

      await expect(
        Model.asUser(OURS, () =>
          Note.$exec("update", {
            where: { id: 61 },
            data: {
              folder: {
                upsert: {
                  create: { code: "unused" },
                  update: { code: "renamed", orgId: 99 },
                },
              },
            },
          }),
        ),
      ).rejects.toThrow(ScopeEscapeError);

      // Nothing landed — the parent's own statement is inside the transaction
      // the step took down with it.
      expect(await folders()).toEqual([
        ["theirs", 99],
        ["ours", 7],
      ]);
    });
  });

  /**
   * **`connect` into an occupied to-one from the owning side (#363)** — where
   * the incumbent is a *sibling of the model being written* rather than a row
   * of the child model.
   *
   * `Cover` is the fixture for it and needs no new one: its `folderId` is the
   * unique foreign key, so `Cover.folder` is the one-to-one read from the end
   * that holds it. Which is exactly why the policy question is different from
   * every other one in this file. The clearing read goes through `Cover`'s own
   * `$exec`, un-pre-scoped — the same rule `clearLinks` applies on the far
   * side — but the statement it runs under is `Cover`'s too, and *that* has
   * already been through the same policies once. One model's scope, consulted
   * twice for two purposes: to choose the row being written, and to choose the
   * rows that may be detached for it.
   *
   * The two answers below are what that resolves to, and neither is derivable
   * from the foreign side's:
   *
   *   a visible incumbent   detached, orphaned, and this row takes the link
   *   a hidden incumbent    nothing detached; the repoint collides on the key
   *
   * The second is the conservative one and the same one `set`, a nested
   * `create` and #361's `connect` give: detaching another tenant's row on a
   * call that never named it is the failure worth refusing, and the cost is a
   * caller who cannot complete the write and is not told why.
   */
  describe("linking into an occupied to-one from the owning side", () => {
    const ourFolder = () =>
      raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );

    const links = async () => {
      const rows: any = await raw.unsafe(
        `SELECT "id", "folderId" FROM "Cover" ORDER BY "id"`,
      );
      return [...rows].map((row: any) => [row.id, row.folderId]);
    };

    test("displaces an incumbent sibling the caller can see, orphaning it", async () => {
      await ourFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (70, 2, 'incumbent', 7), (71, NULL, 'mover', 7)`,
      );

      await Model.asUser(OURS, () =>
        Cover.$exec("update", {
          where: { id: 71 },
          data: { folder: { connect: { id: 2 } } },
        }),
      );

      // Orphaned, not deleted — two rows still, one of them unlinked.
      expect(await links()).toEqual([
        [70, null],
        [71, 2],
      ]);
    });

    test("does not displace an incumbent sibling the caller cannot see", async () => {
      await ourFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (72, 2, 'theirs', 99), (73, NULL, 'mover', 7)`,
      );

      await expect(
        Model.asUser(OURS, () =>
          Cover.$exec("update", {
            where: { id: 73 },
            data: { folder: { connect: { id: 2 } } },
          }),
        ),
      ).rejects.toThrow(UniqueConstraintError);

      // Theirs still linked, ours still loose: the failed repoint took the
      // clear down with it, and the clear never saw the row anyway.
      expect(await links()).toEqual([
        [72, 2],
        [73, null],
      ]);
    });

    /**
     * **The row being written is itself the incumbent, under a policy that
     * scopes on the foreign key** — the arrangement where clearing it would be
     * a silent half-write.
     *
     * Prisma writes nothing at all for an already-linked `connect`: measured
     * with query logging, the call is four selects between a `BEGIN` and a
     * `COMMIT`, with no `update` in it. So skipping the clear is parity rather
     * than a departure — but the reason it is *load-bearing* here is local. The
     * repoint on this side is not a statement of its own; it is a contribution
     * to the main statement, whose `where` carries `folderId = 2` because the
     * policy put it there. A clear that fired would move the row out of that
     * scope *before* the statement ran, so the statement would match nothing
     * and the row would end up detached and never re-attached — `set`'s hazard
     * from #98/#99, arriving on the other side of the key.
     *
     * The scope is what makes this assertable. Without it a clear-then-repoint
     * and the skip land on the same table, and this test cannot fail.
     */
    test("connecting the far row already linked here is a no-op under a key scope", async () => {
      class KeyScoped extends Model {
        static $schema = coverSchema;
        static $policies = [{ scope: () => ({ folderId: 2 }) } as ModelPolicy];
      }
      register("Cover", KeyScoped);

      try {
        await ourFolder();
        await raw.unsafe(
          `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
            `VALUES (74, 2, 'already', 7)`,
        );

        await Model.asUser(OURS, () =>
          KeyScoped.$exec("update", {
            where: { id: 74 },
            data: { folder: { connect: { id: 2 } } },
          }),
        );

        expect(await links()).toEqual([[74, 2]]);
      } finally {
        register("Cover", Cover);
      }
    });

    /**
     * **The detach and the write are one unit** — #363's "a failure anywhere
     * rolls back the detach as well as the repoint", asserted rather than
     * argued from the fact that `$exec` opens a transaction for a plan carrying
     * steps.
     *
     * Not a policy test, and here only because this file has the fixtures for
     * it. The differential cannot host it: it needs a call that clears and
     * *then* fails, and every shape the template's `Profile` can express either
     * never clears — `O12g`'s parent is absent, so the step returns before
     * writing — or clears and succeeds. The one shape that works, a `create`
     * naming a colliding `id`, is not comparable against Prisma, which has no
     * `id` in `ProfileCreateInput` and answers a validation error where gemi
     * answers the unique violation.
     *
     * So: cover 75 holds folder 2 and is the incumbent. The `create` below
     * detaches it to free the key, then collides with it again on the *primary*
     * key. If the clear were outside the transaction, cover 75 would survive
     * with a null `folderId` — detached by a statement that failed, which is
     * the silent half-write this bullet exists to rule out.
     *
     * Verified to fail with the transaction disabled: it is the only test on
     * the owning side that does.
     */
    test("a failure after the detach rolls the detach back", async () => {
      await ourFolder();
      await raw.unsafe(
        `INSERT INTO "Cover" ("id", "folderId", "caption", "orgId") ` +
          `VALUES (75, 2, 'incumbent', 7)`,
      );

      await expect(
        Model.asUser(OURS, () =>
          Cover.$exec("create", {
            data: { id: 75, caption: "collides", folder: { connect: { id: 2 } } },
          }),
        ),
      ).rejects.toThrow(UniqueConstraintError);

      // Still linked. The detach went back with the insert that caused it.
      expect(await links()).toEqual([[75, 2]]);
    });
  });

  /**
   * `set` means **"replace the set I can see"** — #83's answer, applied to an
   * ordinary relation.
   *
   * It is the one supported operand that acts on rows the *call* did not name,
   * so the disconnect half needs a lookup for the child's scope to narrow. A
   * row this caller cannot see stays attached rather than being silently
   * detached, which is the same choice `disconnect` makes one operand over —
   * and the opposite of what an unscoped clear would do.
   */
  test("set replaces only the links the caller can see", async () => {
    await raw.unsafe(
      `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
    );
    // Both linked to our folder; one belongs to the other tenant.
    await raw.unsafe(
      `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
        `VALUES (40, 2, 'ours', 7), (41, 2, 'theirs', 99)`,
    );

    await Model.asUser(OURS, () =>
      Folder.$exec("update", {
        where: { id: 2 },
        data: { code: "ours", notes: { set: [] } },
      }),
    );

    const notes: any = await raw.unsafe(
      `SELECT "id", "folderId" FROM "Note" ORDER BY "id"`,
    );
    // Ours detached; theirs untouched, because the scoped read never saw it.
    expect(notes[0].folderId).toBeNull();
    expect(notes[1].folderId).toBe(2);
  });

  /** With no policy on the child, `set` is Prisma's `set` exactly. */
  test("set clears everything when the child is unpolicied", async () => {
    register("Note", Unpolicied);
    try {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (42, 2, 'a', 7), (43, 2, 'b', 99)`,
      );

      await Model.asUser(OURS, () =>
        Folder.$exec("update", {
          where: { id: 2 },
          data: { code: "ours", notes: { set: [] } },
        }),
      );

      const notes: any = await raw.unsafe(`SELECT "folderId" FROM "Note"`);
      expect(notes.every((n: any) => n.folderId === null)).toBe(true);
    } finally {
      register("Note", Note);
    }
  });

  /**
   * **#98 has landed, so this flipped** — as the pin it replaces said it
   * should, rather than being deleted.
   *
   * A child scoped on its own foreign key used to lose every relation operand
   * that writes that key: `assertNoScopeEscape` read `args.data` and could not
   * tell a column the caller supplied from one the nested step put there. The
   * caller wrote `disconnect: { id }`; `folderId` was in `data` because the ORM
   * chose it.
   *
   * The guard now judges the caller's columns rather than the ORM's, so both
   * operands go through. Kept on both — `disconnect` *and* `connect` — because
   * the original pin's point was that this is a property of the guard rather
   * than of one operand, and that is worth keeping now the answer is success.
   */
  test("a foreign-key scope allows relation operands the ORM keyed", async () => {
    class KeyScoped extends Model {
      static $schema = noteSchema;
      static $policies = [{ scope: () => ({ folderId: 2 }) } as ModelPolicy];
    }
    register("Note", KeyScoped);

    try {
      await raw.unsafe(
        `INSERT INTO "Folder" ("id", "code", "orgId") VALUES (2, 'ours', 7)`,
      );
      await raw.unsafe(
        `INSERT INTO "Note" ("id", "folderId", "label", "orgId") ` +
          `VALUES (20, 2, 'ours', 7)`,
      );

      const attempt = (operand: unknown) =>
        Model.asUser(OURS, () =>
          Folder.$exec("update", {
            where: { id: 2 },
            data: { code: "ours", notes: operand },
          }),
        );

      const linkOf = async () => {
        const rows: any = await raw.unsafe(
          `SELECT "folderId" FROM "Note" WHERE "id" = 20`,
        );
        return rows[0].folderId;
      };

      /**
       * **`set` is still refused, and it goes first because it is the one that
       * has something to leave behind.**
       *
       * It writes the column twice — null to clear, the parent's key to link —
       * and `clearLinks` now names the clear as the ORM's, because the nested
       * `create` beside it needs exactly that clear. The link is deliberately
       * left un-named: with both named the call *succeeds* and leaves the row
       * detached, because the clear puts it outside the very scope
       * (`{ folderId: 2 }`) the link then selects it by. A silent half-write in
       * place of a loud refusal, so the refusal stays until #99 can answer the
       * scope as well as the guard.
       *
       * The row is read back because the clear does run before the link
       * refuses: what makes that harmless is the transaction around the nested
       * steps, not the order of the checks.
       */
      await expect(attempt({ set: [{ id: 20 }] })).rejects.toThrow(ScopeEscapeError);
      expect(await linkOf()).toBe(2);

      // Both of the operands #98 landed for, so this records that it is a
      // property of the guard rather than of the one operand that PR added.
      //
      // `connect` before `disconnect`, and the order is load-bearing now that
      // both succeed: `disconnect` nulls `folderId`, which puts the row outside
      // the scope that has to select it, so a `connect` after it finds nothing.
      // While both were refusals neither wrote anything and the order did not
      // matter.
      await expect(attempt({ connect: { id: 20 } })).resolves.toBeDefined();
      await expect(attempt({ disconnect: { id: 20 } })).resolves.toBeDefined();
      expect(await linkOf()).toBeNull();
    } finally {
      register("Note", Note);
    }
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
