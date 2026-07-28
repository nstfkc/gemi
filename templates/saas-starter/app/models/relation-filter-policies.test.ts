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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * A **scoped** relation filter, against a database.
 *
 * The differential matrix cannot reach this and never will: those cases compare
 * gemi against Prisma, and Prisma has no policies. So a scoped `where: { rel: {
 * every: … } }` has nothing standing over it except unit tests on
 * `applyNestedPolicies` — which is what #58's review pointed out, having tested
 * it by hand. This file makes that check permanent.
 *
 * ### The fixture is arranged so the two candidate rewrites disagree
 *
 * `every: X` compiles to `not exists (child correlated and not X)`. Scoping it by
 * ANDing — `every: X and S` — reads as an obvious simplification and is wrong:
 * an invisible child makes `X and S` false, so it *counts as a failure* and
 * disqualifies the parent on the strength of a row the caller cannot see. The
 * correct rewrite puts the scope outside the negation, `every: { OR: [{ NOT: S },
 * X] }`, which restricts *which children are considered*.
 *
 * A fixture where every child is visible cannot tell those apart. This one can:
 *
 * | | account | visible to alice? |
 * | --- | --- | --- |
 * | alice (org 1) | org 1, role 0 | yes |
 * | alice | org 2, role 5 | **no** |
 * | bob (org 2) | org 2, role 0 | no |
 *
 * Alice's *only* non-matching child is the one she cannot see. Under the correct
 * rewrite she matches `every: { role: 0 }`; under the ANDed one she does not.
 */

const DDL = [
  `DROP TABLE IF EXISTS "Acct"`,
  `DROP TABLE IF EXISTS "Person"`,
  `CREATE TABLE "Person" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "name" TEXT NOT NULL
   )`,
  `CREATE TABLE "Acct" (
     "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
     "personId" INTEGER NOT NULL,
     "orgId" INTEGER NOT NULL,
     "role" INTEGER NOT NULL
   )`,
  `CREATE INDEX "Acct_personId_idx" ON "Acct" ("personId")`,
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

const personSchema: ModelSchema = {
  name: "Person",
  table: "Person",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    name: field("name", "String"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    accts: {
      name: "accts",
      model: "Acct",
      kind: "many",
      relationName: "AcctToPerson",
      from: [],
      to: [],
      nullable: false,
    },
  },
};

const acctSchema: ModelSchema = {
  name: "Acct",
  table: "Acct",
  fields: {
    id: field("id", "Int", { isId: true, default: { kind: "autoincrement" } }),
    personId: field("personId", "Int"),
    orgId: field("orgId", "Int"),
    role: field("role", "Int"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {
    person: {
      name: "person",
      model: "Person",
      kind: "one",
      relationName: "AcctToPerson",
      from: ["personId"],
      to: ["id"],
      nullable: false,
    },
  },
};

const tenant: ModelPolicy = {
  scope: (context) => ({ orgId: (context.user as any).orgId }),
  onCreate: (context, data) => ({
    ...data,
    orgId: (context.user as any).orgId,
  }),
};

class Person extends Model {
  static $schema = personSchema;
}

class Acct extends Model {
  static $schema = acctSchema;
  static $policies = [tenant];
}

const ALICE = { id: 1, orgId: 1 };

describe("a scoped relation filter", () => {
  let workspace: string;
  let database: DatabaseManager;
  let raw: SQL;
  let previous: Application | undefined;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "gemi-orm-relfilter-"));
    const url = `sqlite://${join(workspace, "relfilter.db")}`;

    database = new DatabaseManager({ url });
    raw = new SQL(url);
    for (const statement of DDL) await raw.unsafe(statement);

    previous = Application.getInstance();
    const application = new Application();
    application.instance(DatabaseManager, database as never);
    Application.setInstance(application);

    register("Person", Person);
    register("Acct", Acct);
  }, 120_000);

  afterAll(async () => {
    await raw?.unsafe(`DROP TABLE IF EXISTS "Acct"`).catch(() => {});
    await raw?.unsafe(`DROP TABLE IF EXISTS "Person"`).catch(() => {});
    await raw?.close();
    await database?.close();
    if (previous) Application.setInstance(previous);
    rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearPlanCache();
    await raw.unsafe(`DELETE FROM "Acct"`);
    await raw.unsafe(`DELETE FROM "Person"`);
    await raw.unsafe(
      `INSERT INTO "Person" ("id", "name") VALUES (1, 'alice'), (2, 'bob')`,
    );
    await raw.unsafe(
      `INSERT INTO "Acct" ("personId", "orgId", "role") VALUES
         (1, 1, 0),   -- alice, visible to org 1
         (1, 2, 5),   -- alice, NOT visible to org 1
         (2, 2, 0)`,  // bob, NOT visible to org 1
    );
  });

  const namesFor = async (where: unknown, actor: unknown = ALICE) => {
    const rows = (await (actor === null
      ? Model.asSystem(() =>
          Person.$exec("findMany", { where, orderBy: { id: "asc" } }),
        )
      : Model.asUser(actor, () =>
          Person.$exec("findMany", { where, orderBy: { id: "asc" } }),
        ))) as any[];
    return rows.map((row) => row.name);
  };

  /**
   * The load-bearing case. Alice's only non-matching child is invisible to her,
   * so "every visible child matches" returns her. The ANDed rewrite would not:
   * it treats the invisible child as a failure.
   *
   * Bob matches vacuously — none of his accounts are visible, and `every` over
   * no children is true.
   */
  test("every considers only the children the caller can see", async () => {
    expect(await namesFor({ accts: { every: { role: 0 } } })).toEqual([
      "alice",
      "bob",
    ]);
  });

  /**
   * And the scope is doing the work rather than being a no-op, which is the half
   * that proves the rewrite is live: with policies suspended, Alice's role-5
   * account is considered again and disqualifies her.
   */
  test("the same query under asSystem gives a different answer", async () => {
    expect(await namesFor({ accts: { every: { role: 0 } } }, null)).toEqual([
      "bob",
    ]);
  });

  /** `some: {}` leaks *existence* if unscoped — Bob's account must not count. */
  test("some does not leak the existence of an invisible child", async () => {
    expect(await namesFor({ accts: { some: {} } })).toEqual(["alice"]);
  });

  /** Alice's own invisible account is not matchable either. */
  test("some cannot match a child the caller cannot see", async () => {
    expect(await namesFor({ accts: { some: { role: 5 } } })).toEqual([]);
  });

  test("none is scoped the same way", async () => {
    expect(await namesFor({ accts: { none: { role: 0 } } })).toEqual(["bob"]);
  });

  /**
   * The to-one shorthand and the explicit `is` are the same query, and the
   * policy walk normalises the first into the second. A normalisation can only
   * merge cache keys, never split them — and merging is safe here because the
   * shorthand is *defined* as `is`.
   */
  test("the to-one shorthand and is agree under a policy", async () => {
    const shorthand = (await Model.asUser(ALICE, () =>
      Acct.$exec("findMany", {
        where: { person: { name: "alice" } },
        orderBy: { id: "asc" },
      }),
    )) as any[];
    const explicit = (await Model.asUser(ALICE, () =>
      Acct.$exec("findMany", {
        where: { person: { is: { name: "alice" } } },
        orderBy: { id: "asc" },
      }),
    )) as any[];

    expect(shorthand).toEqual(explicit);
    // Alice's org-2 account is hers but invisible, so one row, not two.
    expect(shorthand).toHaveLength(1);
    expect(shorthand[0].orgId).toBe(1);
  });
});
