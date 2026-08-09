import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  clearPlanCache,
  register,
  type ModelPolicy,
  type ModelSchema,
} from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { POSTGRES_URL } from "./scratch";

/**
 * What `context.operation` says on the row a `delete` hands back — #366.
 *
 * A `delete` that carries an `include` or a `_count` cannot be one statement:
 * the children have to be read before the row goes away. So `$exec` reads with
 * `findFirst` inside a transaction, deletes, and returns **the row it read** —
 * the `delete` statement's own row is discarded. Every other consequence of that
 * split had already been made invisible to the caller: the read is scoped as the
 * delete was, a miss raises `RecordNotFoundError` naming `delete`, and #364
 * taught the pre-read to carry the `omit`. `context.operation` was the last one
 * left showing, and it showed in the worst direction — a `redact` keyed on
 * `"delete"` stopped firing on the returned row the moment an `include` was
 * added beside it.
 *
 * This is a gemi feature with no Prisma counterpart, so there is no differential
 * oracle for it; the authority is internal consistency, and the shape of that
 * claim is *one operation must not answer two ways depending on whether it could
 * be compiled to one statement*. Hence the plain `delete` case sitting beside
 * the two read-first ones: it is the control, and it passed all along.
 *
 * ```prisma
 * model DelOpParent { id Int @id  label String  secret String?  children DelOpChild[] }
 * model DelOpChild  { id Int @id  parentId Int  name String
 *                     parent DelOpParent @relation(fields: [parentId], references: [id]) }
 * ```
 */

const SQLITE_DDL = [
  `DROP TABLE IF EXISTS "DelOpChild"`,
  `DROP TABLE IF EXISTS "DelOpParent"`,
  `CREATE TABLE "DelOpParent" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "label" TEXT NOT NULL,
     "secret" TEXT
   )`,
  `CREATE TABLE "DelOpChild" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "parentId" INTEGER NOT NULL,
     "name" TEXT NOT NULL,
     CONSTRAINT "DelOpChild_parentId_fkey" FOREIGN KEY ("parentId")
       REFERENCES "DelOpParent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
];

const POSTGRES_DDL = [
  `DROP TABLE IF EXISTS "DelOpChild"`,
  `DROP TABLE IF EXISTS "DelOpParent"`,
  `CREATE TABLE "DelOpParent" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "label" TEXT NOT NULL,
     "secret" TEXT
   )`,
  `CREATE TABLE "DelOpChild" (
     "id" SERIAL NOT NULL PRIMARY KEY,
     "parentId" INTEGER NOT NULL,
     "name" TEXT NOT NULL,
     CONSTRAINT "DelOpChild_parentId_fkey" FOREIGN KEY ("parentId")
       REFERENCES "DelOpParent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
  name: "DelOpParent",
  table: "DelOpParent",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    label: field("label", "String"),
    secret: field("secret", "String", { nullable: true }),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    children: {
      name: "children",
      model: "DelOpChild",
      kind: "many",
      relationName: "DelOpChildToDelOpParent",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const childSchema: ModelSchema = {
  name: "DelOpChild",
  table: "DelOpChild",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    parentId: field("parentId", "Int"),
    name: field("name", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    parent: {
      name: "parent",
      model: "DelOpParent",
      kind: "one",
      relationName: "DelOpChildToDelOpParent",
      from: ["parentId"],
      to: ["id"],
      nullable: false,
    },
  },
};

/** Every operation the parent's `redact` was handed, in order, for one case. */
const parentOperations: string[] = [];

/** The same for the child model, so the boundary can be asserted rather than assumed. */
const childOperations: string[] = [];

/**
 * Two branches in one hook, so a single returned row pins both directions.
 *
 * A test that only checks "`delete` redacts" would pass on an implementation
 * that redacts unconditionally. The `findFirst` branch is what makes the
 * assertion about the *operation* rather than about redaction happening at all:
 * on the returned row of a `delete`, `secret` must be gone and `label` must not
 * be, and before the fix it was exactly the other way round.
 */
const parentRedact: ModelPolicy = {
  redact(context, row: any) {
    parentOperations.push(context.operation);
    if (context.operation === "delete") row.secret = null;
    if (context.operation === "findFirst") row.label = null;
  },
};

/**
 * A scope that only exists for reads, which is how the pre-read's *scoping* is
 * pinned separately from its redaction.
 *
 * The pre-read is `markPreScoped`, so `applyPolicies` never runs on it a second
 * time — this fragment cannot reach it, and the `where` the `findFirst` executes
 * is the delete's, predicate for predicate. That is worth an assertion because
 * it is the half of #366 that was *already* right, and the fix must not disturb
 * it: reporting the operation as `delete` for redaction and re-scoping the read
 * as a read are two different changes, and only one of them is wanted.
 */
const parentReadScope: ModelPolicy = {
  scope: (context) =>
    context.operation === "findFirst" ? { label: "no-such-label" } : undefined,
};

class DelOpParent extends Model {
  static $schema = parentSchema;
  static $policies = [parentRedact, parentReadScope];
}

class DelOpChild extends Model {
  static $schema = childSchema;
  static $policies: ModelPolicy[] = [
    {
      redact(context) {
        childOperations.push(context.operation);
      },
    },
  ];
}

/**
 * `resolve` owns whatever it had to create to produce a URL, and hands back the
 * teardown for it. The alternative — a module-level `workspace` the SQLite
 * resolver sets and both `afterAll`s read — is cross-suite mutable state: the
 * Postgres suite would try to remove the SQLite suite's temp directory. Harmless
 * while describes run in order in one worker and `force: true` swallows the
 * second call, but it is exactly the kind of shared handle that stops being
 * harmless the day the two dialects run in separate workers.
 */
function suite(
  label: string,
  resolve: () => { url: string; cleanup?: () => void },
  ddl: string[],
) {
  describe(label, () => {
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;
    let cleanup: (() => void) | undefined;

    beforeAll(async () => {
      const resolved = resolve();
      const url = resolved.url;
      cleanup = resolved.cleanup;
      database = new DatabaseManager({ url });
      raw = new SQL(url);
      for (const statement of ddl) await raw.unsafe(statement);
      if (label.includes("sqlite")) {
        await raw.unsafe(`PRAGMA foreign_keys = ON`);
        await database.sql.unsafe(`PRAGMA foreign_keys = ON`);
      }

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);

      register("DelOpParent", DelOpParent);
      register("DelOpChild", DelOpChild);
    }, 120_000);

    afterAll(async () => {
      await raw?.unsafe(`DROP TABLE IF EXISTS "DelOpChild"`).catch(() => {});
      await raw?.unsafe(`DROP TABLE IF EXISTS "DelOpParent"`).catch(() => {});
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      cleanup?.();
    });

    beforeEach(async () => {
      clearPlanCache();
      parentOperations.length = 0;
      childOperations.length = 0;
      await raw.unsafe(`DELETE FROM "DelOpChild"`);
      await raw.unsafe(`DELETE FROM "DelOpParent"`);

      // Seeded under `asSystem`, which suspends policies entirely — so the
      // `scope` above never meets a `create`, where a scope with no `onCreate`
      // is refused by name.
      await Model.asSystem(async () => {
        const parent: any = await DelOpParent.$exec("create", {
          data: { label: "kept", secret: "hunter2" },
        });
        await DelOpChild.$exec("create", {
          data: { parentId: parent.id, name: "a" },
        });
        await DelOpChild.$exec("create", {
          data: { parentId: parent.id, name: "b" },
        });
      });
    });

    async function only(): Promise<any> {
      const rows = (await Model.asSystem(() =>
        DelOpParent.$exec("findMany", {}),
      )) as any[];
      return rows[0];
    }

    /**
     * The control. One statement, no pre-read, and it has always reported
     * `delete` — which is what makes the two below a divergence within one
     * operation rather than an open question about what `delete` should mean.
     */
    test("a plain delete redacts under delete", async () => {
      const parent = await only();

      const deleted: any = await DelOpParent.$exec("delete", {
        where: { id: parent.id },
      });

      expect(deleted.secret).toBe(null);
      expect(deleted.label).toBe("kept");
      expect(parentOperations).toEqual(["delete"]);
    });

    /** #366: the same call, plus an `include`, used to come back unredacted. */
    test("a delete with an include redacts under delete", async () => {
      const parent = await only();

      const deleted: any = await DelOpParent.$exec("delete", {
        where: { id: parent.id },
        include: { children: true },
      });

      expect(deleted.secret).toBe(null);
      expect(deleted.label).toBe("kept");
      expect(deleted.children).toHaveLength(2);
    });

    /**
     * The other half of the branch's condition. A `_count` has no relation plan
     * behind it, so `plan.counts` is what routes this one — a separate way in,
     * and therefore a separate case.
     */
    test("a delete with a _count redacts under delete", async () => {
      const parent = await only();

      const deleted: any = await DelOpParent.$exec("delete", {
        where: { id: parent.id },
        include: { _count: { select: { children: true } } },
      });

      expect(deleted.secret).toBe(null);
      expect(deleted.label).toBe("kept");
      expect(deleted._count).toEqual({ children: 2 });
    });

    /**
     * The row is redacted once, as one operation — not once as a read and again
     * as a write. The second entry belongs to the inner `delete` statement,
     * whose row is discarded; the returned row is the first.
     */
    test("neither invocation reports the read it was compiled as", async () => {
      const parent = await only();

      await DelOpParent.$exec("delete", {
        where: { id: parent.id },
        include: { children: true },
      });

      expect(parentOperations).toEqual(["delete", "delete"]);
    });

    /**
     * The marker travels with one call and no further: an ordinary read still
     * reports itself as one, so nothing outside the read-first `delete` can
     * start claiming to be a write.
     */
    test("an ordinary read still reports its own operation", async () => {
      await DelOpParent.$exec("findMany", { include: { children: true } });

      expect(parentOperations).toEqual(["findMany"]);
    });

    /**
     * The boundary. A relation read underneath is a read of another model, and
     * `NESTED_READ` in `policy.ts` is a constant precisely so it stays one
     * whatever statement encloses it.
     *
     * Pinned under `batched` explicitly because that is the strategy both
     * dialects have. Which read-name a *folded* child sees is strategy-dependent
     * today — `redactFolded` passes the enclosing operation down, so a lateral
     * child of this pre-read is told `findFirst` where a batched one is told
     * `findMany`. Both were measured; the divergence predates this change, is
     * about two reads disagreeing rather than a read reporting a write, and is
     * out of #366's scope. It is filed as **#388**, whose fix — handing
     * `redactFolded` the same `NESTED_READ` constant — would make the case below
     * pinnable as an equality on both dialects. What must hold until then is the
     * case below.
     */
    test("a nested read is still redacted as a read", async () => {
      const parent = await only();

      await DelOpParent.$exec(
        "delete",
        { where: { id: parent.id }, include: { children: true } },
        { strategy: "batched" } as never,
      );

      // Deduplicated: `redact` runs per row, and the fixture seeds two children.
      // The claim is about which operation they are told, not how many of them
      // there are.
      expect([...new Set(childOperations)]).toEqual(["findMany"]);
    });

    test("and never as the delete that encloses it, under the default strategy", async () => {
      const parent = await only();

      await DelOpParent.$exec("delete", {
        where: { id: parent.id },
        include: { children: true },
      });

      // Not an equality: the value differs by dialect, because the default
      // strategy does. Measured — `findMany` on SQLite (batched), `findFirst` on
      // Postgres (lateral, where `redactFolded` passes the enclosing read's
      // name — #388). Neither is the write, which is the part that has to hold,
      // and pinning either literal here would make this suite fail on one
      // dialect for a divergence that is not #366's.
      expect(childOperations).not.toContain("delete");
      expect(childOperations.length).toBeGreaterThan(0);
    });

    /**
     * The scope keyed on `findFirst` is real — this is the assertion that gives
     * the next one its teeth.
     */
    test("a read-only scope applies to a read", async () => {
      const parent = await only();

      expect(
        await DelOpParent.$exec("findFirst", { where: { id: parent.id } }),
      ).toBe(null);
    });

    /**
     * …and does not apply to the pre-read, which is not a second read: its args
     * arrive already scoped as the delete's, and `markPreScoped` is what stops
     * them being scoped again. Redacting the returned row as a `delete` did not
     * change that, and it must not.
     */
    test("but not to the pre-read of a delete", async () => {
      const parent = await only();

      const deleted: any = await DelOpParent.$exec("delete", {
        where: { id: parent.id },
        include: { children: true },
      });

      expect(deleted.id).toBe(parent.id);
      expect(await Model.asSystem(() => DelOpParent.$exec("count", {}))).toBe(
        0,
      );
    });
  });
}

suite(
  "delete redaction operation — sqlite",
  () => {
    const workspace = mkdtempSync(join(tmpdir(), "gemi-orm-delete-redact-"));
    return {
      url: `sqlite://${join(workspace, "delete-redact.db")}`,
      cleanup: () => rmSync(workspace, { recursive: true, force: true }),
    };
  },
  SQLITE_DDL,
);

if (POSTGRES_URL) {
  // No `cleanup`: the database is the caller's, and the tables are dropped by
  // the shared `afterAll` either way.
  suite(
    "delete redaction operation — postgres",
    () => ({ url: POSTGRES_URL }),
    POSTGRES_DDL,
  );
} else {
  describe.skip("delete redaction operation — postgres", () => {
    test("skipped", () => {});
  });
}
