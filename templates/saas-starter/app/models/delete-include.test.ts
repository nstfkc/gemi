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
  type ModelSchema,
} from "gemi/orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * `delete` with an `include` on a **cascading** relation.
 *
 * Iteration 4 shipped this as a known divergence and said exactly when it would
 * become fixable:
 *
 * > The relation reads run *after* the delete statement… the database has
 * > already removed the children by then, so the `include` comes back empty.
 * > Not fixable at this layer. The fix is to read the relations before the
 * > delete inside one transaction, which is iteration 5's to provide — and once
 * > it does, **this is the case to write the test for**.
 *
 * A fixture rather than the template's schema, for the reason that note gives:
 * the template declares no cascades, so the differential harness cannot reach
 * this. The first cascading model added to any application would.
 *
 * ```prisma
 * model Parent   { id Int @id  name String  children Child[] }
 * model Child    { id Int @id  parentId Int  label String
 *                  parent Parent @relation(fields: [parentId], references: [id], onDelete: Cascade) }
 * ```
 */

const SQLITE_DDL = [
  `DROP TABLE IF EXISTS "Child"`,
  `DROP TABLE IF EXISTS "Parent"`,
  `CREATE TABLE "Parent" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "name" TEXT NOT NULL
   )`,
  `CREATE TABLE "Child" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "parentId" INTEGER NOT NULL,
     "label" TEXT NOT NULL,
     CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId")
       REFERENCES "Parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
];

const POSTGRES_DDL = [
  `DROP TABLE IF EXISTS "Child"`,
  `DROP TABLE IF EXISTS "Parent"`,
  `CREATE TABLE "Parent" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "name" TEXT NOT NULL
   )`,
  `CREATE TABLE "Child" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "parentId" INTEGER NOT NULL,
     "label" TEXT NOT NULL,
     CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId")
       REFERENCES "Parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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

const parentSchema: ModelSchema = {
  name: "Parent",
  table: "Parent",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    name: field("name", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    children: {
      name: "children",
      model: "Child",
      kind: "many",
      relationName: "ChildToParent",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const childSchema: ModelSchema = {
  name: "Child",
  table: "Child",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    parentId: field("parentId", "Int"),
    label: field("label", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    parent: {
      name: "parent",
      model: "Parent",
      kind: "one",
      relationName: "ChildToParent",
      from: ["parentId"],
      to: ["id"],
      nullable: false,
    },
  },
};

class Parent extends Model {
  static $schema = parentSchema;
}
class Child extends Model {
  static $schema = childSchema;
}

function suite(label: string, resolve: () => string, ddl: string[]) {
  describe(label, () => {
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      // A file rather than `:memory:`: an in-memory SQLite database belongs to
      // one connection, and this suite needs two — the manager's and the raw
      // handle the DDL and the assertions go through.
      const url = resolve();
      database = new DatabaseManager({ url });
      raw = new SQL(url);
      for (const statement of ddl) await raw.unsafe(statement);
      // SQLite enforces foreign keys — and therefore cascades — only when asked,
      // and the pragma is **per connection**. Setting it on `raw` alone left the
      // ORM's own connection with cascades off, which made this suite pass for
      // the wrong reason: with no cascade the children still exist after the
      // delete, so reading them afterwards finds them and the bug this file
      // exists for does not reproduce at all.
      if (label.includes("sqlite")) {
        await raw.unsafe(`PRAGMA foreign_keys = ON`);
        await database.sql.unsafe(`PRAGMA foreign_keys = ON`);
      }

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      register("Parent", Parent);
      register("Child", Child);
    }, 120_000);

    afterAll(async () => {
      await raw?.unsafe(`DROP TABLE IF EXISTS "Child"`).catch(() => {});
      await raw?.unsafe(`DROP TABLE IF EXISTS "Parent"`).catch(() => {});
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    beforeEach(async () => {
      clearPlanCache();
      await raw.unsafe(`DELETE FROM "Child"`);
      await raw.unsafe(`DELETE FROM "Parent"`);

      await Model.asSystem(async () => {
        const parent: any = await Parent.$exec("create", {
          data: { name: "kept" },
        });
        await Child.$exec("create", {
          data: { parentId: parent.id, label: "a" },
        });
        await Child.$exec("create", {
          data: { parentId: parent.id, label: "b" },
        });
      });
    });

    async function only(): Promise<any> {
      const rows = (await Model.asSystem(() =>
        Parent.$exec("findMany", {}),
      )) as any[];
      return rows[0];
    }

    /** The bug, and the whole reason this file exists. */
    test("the include returns the children the delete removed", async () => {
      const parent = await only();

      const deleted: any = await Model.asSystem(() =>
        Parent.$exec("delete", {
          where: { id: parent.id },
          include: { children: true },
        }),
      );

      expect(deleted.name).toBe("kept");
      expect(deleted.children.map((child: any) => child.label).sort()).toEqual([
        "a",
        "b",
      ]);
    });

    test("and the rows really are gone, parent and cascaded children", async () => {
      const parent = await only();

      await Model.asSystem(() =>
        Parent.$exec("delete", {
          where: { id: parent.id },
          include: { children: true },
        }),
      );

      expect(await Model.asSystem(() => Parent.$exec("count", {}))).toBe(0);
      expect(await Model.asSystem(() => Child.$exec("count", {}))).toBe(0);
    });

    /**
     * A `select` naming the relation takes the same path, and must still return
     * exactly the keys it named — the pre-read is the caller's projection, not a
     * full row.
     */
    test("a select naming the relation returns only what it named", async () => {
      const parent = await only();

      const deleted: any = await Model.asSystem(() =>
        Parent.$exec("delete", {
          where: { id: parent.id },
          select: { name: true, children: { select: { label: true } } },
        }),
      );

      expect(Object.keys(deleted).sort()).toEqual(["children", "name"]);
      expect(deleted.children[0]).toEqual({ label: expect.any(String) });
    });

    /**
     * `omit` beside the `include`, which is the pair the read-first path used to
     * lose.
     *
     * Prisma rejects `select` + `omit` — they describe two different column
     * lists — but accepts `include` + `omit`, and so does the compiler here:
     * `delete`'s operand set names all four, and a `delete` with no relation
     * compiles the `omit` into its `RETURNING` through `resolveSelection` like
     * any other projection.
     *
     * The read-first path did not. It rebuilt the pre-read's projection from
     * `select` or `include` alone and returned that row verbatim, so adding an
     * `include` to a call that already omitted a column silently handed the
     * column back. The column a caller omits is the one it had a reason to hide
     * — a password hash, in the application that found this — so the failure
     * mode is a leak, not a shape mismatch.
     */
    test("an omit beside the include still drops the column", async () => {
      const parent = await only();

      const deleted: any = await Model.asSystem(() =>
        Parent.$exec("delete", {
          where: { id: parent.id },
          include: { children: true },
          omit: { name: true },
        }),
      );

      expect(deleted).not.toHaveProperty("name");
      expect(deleted.id).toBe(parent.id);
      expect(deleted.children.map((child: any) => child.label).sort()).toEqual([
        "a",
        "b",
      ]);
    });

    /**
     * A `_count` on its own takes the same path by the other half of the
     * condition — `plan.counts` rather than `plan.relations` — so it has to
     * carry the `omit` too.
     */
    test("an omit beside a _count still drops the column", async () => {
      const parent = await only();

      const deleted: any = await Model.asSystem(() =>
        Parent.$exec("delete", {
          where: { id: parent.id },
          include: { _count: { select: { children: true } } },
          omit: { name: true },
        }),
      );

      expect(deleted).not.toHaveProperty("name");
      expect(deleted._count).toEqual({ children: 2 });
    });

    /** No relation asked for: still one statement, still no transaction. */
    test("a plain delete is unchanged", async () => {
      const parent = await only();

      const deleted: any = await Model.asSystem(() =>
        Parent.$exec("delete", { where: { id: parent.id } }),
      );

      expect(deleted.name).toBe("kept");
      expect(deleted.children).toBeUndefined();
    });

    /**
     * The read reports the miss as a *delete*, not as the `findFirst` it uses
     * underneath. An error naming an operation the caller never issued is worse
     * than no error at all.
     */
    test("a miss raises RecordNotFoundError naming delete", async () => {
      await expect(
        Model.asSystem(() =>
          Parent.$exec("delete", {
            where: { id: 987_654 },
            include: { children: true },
          }),
        ),
      ).rejects.toThrow(RecordNotFoundError);
    });

    /**
     * Inside a caller's transaction the pair becomes a savepoint rather than a
     * second transaction — and rolling the outer one back has to take the delete
     * with it, or the read-then-write would be atomic only when nobody else was
     * using a transaction.
     */
    test("it rolls back with an enclosing transaction", async () => {
      const parent = await only();

      await expect(
        Model.asSystem(() =>
          Model.transaction(async () => {
            const deleted: any = await Parent.$exec("delete", {
              where: { id: parent.id },
              include: { children: true },
            });
            expect(deleted.children).toHaveLength(2);
            throw new Error("rollback");
          }),
        ),
      ).rejects.toThrow("rollback");

      expect(await Model.asSystem(() => Parent.$exec("count", {}))).toBe(1);
      expect(await Model.asSystem(() => Child.$exec("count", {}))).toBe(2);
    });
  });
}

let workspace: string | undefined;

suite(
  "delete + include — sqlite",
  () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-delete-"));
    return `sqlite://${join(workspace, "delete.db")}`;
  },
  SQLITE_DDL,
);

if (POSTGRES_URL) {
  suite("delete + include — postgres", () => POSTGRES_URL, POSTGRES_DDL);
} else {
  describe.skip("delete + include — postgres", () => {
    test("skipped", () => {});
  });
}
